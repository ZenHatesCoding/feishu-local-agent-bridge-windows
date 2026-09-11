param([string]$Config, [switch]$RestoreOriginals)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

$agents = @(Get-CollabLocalAgents)
[array]::Reverse($agents)
foreach ($agent in $agents) { & (Join-Path $PSScriptRoot 'Stop-CollabAgent.ps1') -Agent $agent.id }
if (Test-CollabRunsHub) {
  Stop-CollabComponent 'hub'
  Write-Output 'Collaboration Hub stopped.'
}

if ($RestoreOriginals) {
  [array]::Reverse($agents)
  foreach ($agent in $agents) { Start-OriginalAgent $agent }
  Write-Output 'All configured original bridges restored.'
}
