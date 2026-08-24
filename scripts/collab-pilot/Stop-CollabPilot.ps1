param([switch]$RestoreOriginals)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

foreach ($agent in 'fool', 'chariot', 'justice', 'world') {
  & (Join-Path $PSScriptRoot 'Stop-CollabAgent.ps1') -Agent $agent
}
Stop-CollabComponent 'hub'
Write-Output 'Collaboration Hub stopped.'

if ($RestoreOriginals) {
  foreach ($agent in 'world', 'justice', 'chariot', 'fool') {
    Start-OriginalAgent $agent
  }
  Write-Output 'All original bridges restored.'
}
