param([Parameter(Mandatory = $true)][string]$Agent)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

$pilot = Get-CollabPilotConfig
$agentConfig = Get-CollabAgent $Agent
$commandDir = Join-Path $script:CollabRepoRoot 'scripts\collab-pilot\bin'

$env:LARK_COLLAB_HUB_URL = Get-CollabHubUrl
$env:LARK_COLLAB_HUB_TOKEN = Get-CollabAgentToken $agentConfig
$env:LARK_COLLAB_TENANT_KEY = Get-CollabTenantKey
$env:LARK_COLLAB_AGENT_ID = $Agent
$env:LARK_COLLAB_NODE_ID = if ($pilot.nodeId) { [string]$pilot.nodeId } else { [Environment]::MachineName }
$env:LARK_COLLAB_INSTANCE_ID = "$($env:LARK_COLLAB_NODE_ID):$Agent"
# With a configured coordinator, every execution bridge consumes the one
# canonical Hub dispatch.  No bot is allowed to infer a partial target set
# from its own callback delivery.
$env:LARK_COLLAB_EVENT_SOURCE = if ($pilot.hub.coordinator -and $pilot.hub.coordinator.enabled) { 'coordinator' } else { 'distributed' }
$env:LARK_COLLAB_AGENT_ROSTER = @(
  Get-CollabAgents | ForEach-Object {
    [ordered]@{ id = [string]$_.id; displayName = [string]$_.displayName; aliases = @($_.aliases) }
  }
) | ConvertTo-Json -Compress
$env:LARK_COLLAB_ARTIFACT_ROOT = Join-Path $script:CollabStateDir 'artifacts'
$env:LARK_COLLAB_NODE_LEDGER_ROOT = Join-Path $script:CollabStateDir 'local-topic-ledger'
$env:LARK_COLLAB_COMMAND_DIR = $commandDir
Export-CollabRealLarkCliJs -Pilot $pilot -LaunchFilePath $agentConfig.launch.filePath

foreach ($name in @(
  'LARK_CHANNEL',
  'LARK_CHANNEL_UNATTENDED',
  'LARK_CHANNEL_HOME',
  'LARK_CHANNEL_PROFILE',
  'LARK_CHANNEL_CONFIG',
  'LARK_MEMORY_HARNESS_PATCH',
  'LARKSUITE_CLI_CONFIG_DIR',
  'LARK_CHANNEL_CODEX_BIN',
  'LARK_CHANNEL_NODE_BIN',
  'LARK_CHANNEL_ANTIGRAVITY_BIN',
  'LARK_CHANNEL_ANTIGRAVITY_TRANSPORT',
  'LARK_ANTIGRAVITY_DESKTOP_ROOT',
  'LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY',
  'LARK_CHANNEL_ANTIGRAVITY_BRIDGE',
  'LARK_CHANNEL_DEEPSEEK_HARNESS_BRIDGE',
  'DSH_CWD'
)) {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
foreach ($name in @($pilot.unsetEnvironment)) {
  if ($name) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
Set-CollabEnvironment $pilot.commonEnvironment
Set-CollabEnvironment $agentConfig.launch.environment
foreach ($name in @($agentConfig.launch.unsetEnvironment)) {
  if ($name) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
# Keep the codex binary fresh across codex auto-updates. codex installs into a
# new hash version directory on every update and guts the previous one (removing
# codex-code-mode-host.exe, which codex spawns to run shell tools). Resolve the
# newest *complete* install, write it back to the lark-channel codex profile
# config and this pilot manifest, and surface it as the launch env so the bridge
# never starts against a gutted directory. Opt out with
# LARK_CHANNEL_CODEX_BIN_DISABLE_RESOLVE=1. Best-effort: never blocks a launch.
if ($env:LARK_CHANNEL_CODEX_BIN_DISABLE_RESOLVE -ne '1' -and $agentConfig.launch.environment -and $agentConfig.launch.environment.LARK_CHANNEL_CODEX_BIN) {
  $launchArgs = @($agentConfig.launch.arguments)
  $profileAt = [Array]::IndexOf($launchArgs, '--profile')
  $codexProfile = if ($profileAt -ge 0 -and $profileAt + 1 -lt $launchArgs.Count) { $launchArgs[$profileAt + 1] } else { $env:LARK_CHANNEL_PROFILE }
  $resolveArgs = @{ Quiet = $true; AgentId = $Agent; PilotConfig = $script:CollabManifestFile }
  if ($codexProfile) { $resolveArgs.ProfileName = $codexProfile }
  else { $resolveArgs.SkipProfileWrite = $true }
  $configAt = [Array]::IndexOf($launchArgs, '--config')
  if ($configAt -ge 0 -and $configAt + 1 -lt $launchArgs.Count) { $resolveArgs.ConfigJson = Expand-CollabValue $launchArgs[$configAt + 1] }
  elseif ($env:LARK_CHANNEL_CONFIG) { $resolveArgs.ConfigJson = $env:LARK_CHANNEL_CONFIG }
  elseif ($env:LARK_CHANNEL_HOME) { $resolveArgs.ConfigJson = Join-Path $env:LARK_CHANNEL_HOME 'config.json' }
  try {
    $resolvedCodexBin = & (Join-Path $PSScriptRoot 'Resolve-CodexBinary.ps1') @resolveArgs 2>$null
    if ($resolvedCodexBin) {
      [Environment]::SetEnvironmentVariable('LARK_CHANNEL_CODEX_BIN', $resolvedCodexBin, 'Process')
    }
  } catch {
    Write-Warning "[run-agent] codex binary resolve failed; continuing with the configured path. $($_.Exception.Message)"
  }
}
if ($env:LARK_CHANNEL_ANTIGRAVITY_TRANSPORT -ne 'desktop' -and [System.IO.Path]::GetFileName([string]$env:LARK_CHANNEL_ANTIGRAVITY_BIN) -ieq 'agy.exe') {
  . (Join-Path $script:CollabRepoRoot 'scripts\antigravity-proxy-env.ps1')
  Initialize-AntigravityProxyEnvironment
}
# Tool runtimes such as DeepSeek Harness intentionally scrub ambient variables
# whose names look like credentials before starting a model shell.  Publish and
# collaboration commands still need this Agent's already-scoped Hub capability,
# so expose it under the explicit tool-boundary name understood by the bridge.
# This is assigned after all launch overrides so every local Bot has the same
# durable delivery contract.
$env:LARK_COLLAB_TOOL_HUB_CREDENTIAL = $env:LARK_COLLAB_HUB_TOKEN
$memoryEnabled = !($pilot.memory -and $pilot.memory.enabled -eq $false) -and !($agentConfig.memory -and $agentConfig.memory.enabled -eq $false)
$env:LARK_MEMORY_ENABLED = if ($memoryEnabled) { '1' } else { '0' }
$env:LARK_MEMORY_MAX_TOKENS = if ($agentConfig.memory -and $agentConfig.memory.maxMemoryTokens) { [string]$agentConfig.memory.maxMemoryTokens } elseif ($pilot.memory -and $pilot.memory.maxMemoryTokens) { [string]$pilot.memory.maxMemoryTokens } else { '12000' }
$env:LARK_MEMORY_BACKGROUND = if (($agentConfig.memory -and $agentConfig.memory.maintenance -and $agentConfig.memory.maintenance.backgroundEnabled -eq $false) -or ($pilot.memory -and $pilot.memory.maintenance -and $pilot.memory.maintenance.backgroundEnabled -eq $false)) { '0' } else { '1' }
$env:LARK_MEMORY_ROOT = Join-Path (Join-Path $script:CollabStateDir 'worker-memory') $Agent
# New local observations are per instance; the historical shared ledger stays untouched.
$env:LARK_COLLAB_NODE_LEDGER_ROOT = Join-Path (Join-Path $script:CollabStateDir 'worker-journals') $Agent
$env:LARK_MEMORY_NODE_BIN = (Get-Command node -ErrorAction Stop).Source
$env:LARK_MEMORY_CLI = Join-Path $script:CollabRepoRoot 'dist\cli.js'
$env:LARK_MEMORY_ASSET_ROOT = Join-Path $script:CollabRepoRoot 'adapters\memory'
$agentArguments = @($agentConfig.launch.arguments)
$kindIndex = [Array]::IndexOf($agentArguments, '--agent')
$profileIndex = [Array]::IndexOf($agentArguments, '--profile')
$env:LARK_MEMORY_HOST = if ($agentConfig.hermesHook -and $agentConfig.hermesHook.enabled) { 'hermes' } elseif ($kindIndex -ge 0) { [string]$agentArguments[$kindIndex + 1] } elseif ($profileIndex -ge 0) { [string]$agentArguments[$profileIndex + 1] } else { 'codex' }
if ($agentConfig.hermesHook -and $agentConfig.hermesHook.enabled) {
  $env:LARK_MEMORY_HERMES_PYTHON = Expand-CollabValue $agentConfig.launch.filePath
  $env:LARK_MEMORY_HERMES_HELPER = Join-Path (Expand-CollabValue $agentConfig.hermesHook.home) 'hooks\feishu-collaboration-hub\memory_synthesize.py'
}
# Agent-specific PATH overrides are applied above. Put the Pilot's
# identity-neutral commands first only after every override is complete.
$env:PATH = "$commandDir;$env:PATH"

$filePath = Expand-CollabValue $agentConfig.launch.filePath
$arguments = @($agentConfig.launch.arguments | ForEach-Object { Expand-CollabValue $_ })
$workingDirectory = if ($agentConfig.launch.workingDirectory) { Expand-CollabValue $agentConfig.launch.workingDirectory } else { $script:CollabRepoRoot }
Push-Location -LiteralPath $workingDirectory
try {
  & $filePath @arguments
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
