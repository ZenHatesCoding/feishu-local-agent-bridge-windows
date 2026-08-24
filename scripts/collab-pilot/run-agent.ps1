param([Parameter(Mandatory = $true)][string]$Agent)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

$pilot = Get-CollabPilotConfig
$agentConfig = Get-CollabAgent $Agent
$commandDir = Join-Path $script:CollabRepoRoot 'scripts\collab-pilot\bin'

$env:LARK_COLLAB_HUB_URL = Get-CollabHubUrl
$env:LARK_COLLAB_HUB_TOKEN = (Get-Content -LiteralPath $script:CollabTokenFile -Raw).Trim()
$env:LARK_COLLAB_TENANT_KEY = (Get-Content -LiteralPath $script:CollabTenantFile -Raw).Trim()
$env:LARK_COLLAB_AGENT_ID = $Agent
$env:LARK_COLLAB_EVENT_SOURCE = 'distributed'
$env:LARK_COLLAB_ARTIFACT_ROOT = Join-Path $script:CollabStateDir 'artifacts'
$env:LARK_COLLAB_COMMAND_DIR = $commandDir
$env:PATH = "$commandDir;$env:PATH"
if ($pilot.larkCliJs) { $env:LARK_COLLAB_REAL_LARK_CLI_JS = Expand-CollabValue $pilot.larkCliJs }

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
