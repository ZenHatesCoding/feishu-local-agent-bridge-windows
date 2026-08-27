param([string]$Config)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

Initialize-CollabRuntimeState
if (Test-CollabRunsHub) { & (Join-Path $PSScriptRoot 'Start-CollabHub.ps1') -Quiet }
if (Test-CollabRunsAgents) {
  foreach ($agent in Get-CollabLocalAgents) {
    & (Join-Path $PSScriptRoot 'Start-CollabAgent.ps1') -Agent $agent.id -SkipStatus
  }
}
& (Join-Path $PSScriptRoot 'Status-CollabPilot.ps1')
