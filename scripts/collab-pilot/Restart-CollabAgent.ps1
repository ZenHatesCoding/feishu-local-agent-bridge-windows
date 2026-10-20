param(
  [Parameter(Mandatory = $true)][string]$Agent,
  [string]$Config
)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')
$agentConfig = Get-CollabAgent $Agent
# A detached Hermes gateway must actually exit before updated Hooks can load.
if ($agentConfig.hermesHook -and $agentConfig.hermesHook.enabled -and (Test-CollabHermesGateway $agentConfig)) {
  $previousHermesHome = $env:HERMES_HOME
  try {
    $env:HERMES_HOME = Expand-CollabValue $agentConfig.hermesHook.home
    Stop-OriginalAgent $agentConfig
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Test-CollabHermesGateway $agentConfig) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Seconds 1 }
    if (Test-CollabHermesGateway $agentConfig) { throw 'Hermes gateway did not stop; refusing to start a duplicate.' }
  } finally {
    if ($null -eq $previousHermesHome) { Remove-Item Env:HERMES_HOME -ErrorAction SilentlyContinue }
    else { $env:HERMES_HOME = $previousHermesHome }
  }
}
& (Join-Path $PSScriptRoot 'Stop-CollabAgent.ps1') -Agent $Agent
& (Join-Path $PSScriptRoot 'Start-CollabAgent.ps1') -Agent $Agent
