$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'Start-CollabHub.ps1') -Quiet
foreach ($agent in 'world', 'justice', 'chariot', 'fool') {
  & (Join-Path $PSScriptRoot 'Start-CollabAgent.ps1') -Agent $agent -SkipStatus
}
& (Join-Path $PSScriptRoot 'Status-CollabPilot.ps1')
