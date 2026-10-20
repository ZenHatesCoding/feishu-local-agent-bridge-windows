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
$env:LARK_COLLAB_EVENT_SOURCE = 'distributed'
$env:LARK_COLLAB_ARTIFACT_ROOT = Join-Path $script:CollabStateDir 'artifacts'
# One journal per AGENT, not per machine: each worker is an independent unit
# (two agents on the same box must behave exactly like two separate machines).
# Sharing one file made every agent append its own copy of the same group
# message, so the journal grew N-fold on an N-worker node.
$env:LARK_COLLAB_NODE_LEDGER_ROOT = Join-Path $script:CollabStateDir "local-topic-ledger\$Agent"
$env:LARK_COLLAB_COMMAND_DIR = $commandDir
Export-CollabRealLarkCliJs -Pilot $pilot -LaunchFilePath $agentConfig.launch.filePath

foreach ($name in @(
  'LARK_CHANNEL',
  'LARK_CHANNEL_UNATTENDED',
  'LARK_CHANNEL_HOME',
  'LARK_CHANNEL_PROFILE',
  'LARK_CHANNEL_CONFIG',
  'LARKSUITE_CLI_CONFIG_DIR',
  'LARK_CHANNEL_CODEX_BIN',
  'LARK_CHANNEL_NODE_BIN',
  'LARK_CHANNEL_ANTIGRAVITY_BIN',
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
if ([System.IO.Path]::GetFileName([string]$env:LARK_CHANNEL_ANTIGRAVITY_BIN) -ieq 'agy.exe') {
  . (Join-Path $script:CollabRepoRoot 'scripts\antigravity-proxy-env.ps1')
  Initialize-AntigravityProxyEnvironment
}
foreach ($name in @($agentConfig.launch.unsetEnvironment)) {
  if ($name) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}
$memoryEnabled = !($pilot.memory -and $pilot.memory.enabled -eq $false) -and !($agentConfig.memory -and $agentConfig.memory.enabled -eq $false)
$env:LARK_MEMORY_ENABLED = if ($memoryEnabled) { '1' } else { '0' }
$env:LARK_MEMORY_MAX_TOKENS = if ($agentConfig.memory -and $agentConfig.memory.maxMemoryTokens) { [string]$agentConfig.memory.maxMemoryTokens } elseif ($pilot.memory -and $pilot.memory.maxMemoryTokens) { [string]$pilot.memory.maxMemoryTokens } else { '12000' }
$env:LARK_MEMORY_BACKGROUND = if (($agentConfig.memory -and $agentConfig.memory.maintenance -and $agentConfig.memory.maintenance.backgroundEnabled -eq $false) -or ($pilot.memory -and $pilot.memory.maintenance -and $pilot.memory.maintenance.backgroundEnabled -eq $false)) { '0' } else { '1' }
$env:LARK_MEMORY_ROOT = Join-Path (Join-Path $script:CollabStateDir 'worker-memory') $Agent
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
