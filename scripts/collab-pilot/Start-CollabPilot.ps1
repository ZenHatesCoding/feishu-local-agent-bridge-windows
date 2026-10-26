param([string]$Config)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')
. (Join-Path $PSScriptRoot 'Repair.Common.ps1')

function Write-RepairPhase([string]$Message) { Write-Output "[repair $(Get-Date -Format 'HH:mm:ss.fff')] $Message" }

Write-RepairPhase 'Initialize-CollabRuntimeState'
Initialize-CollabRuntimeState
$failures = @()
if (Test-CollabRunsHub) {
  Write-RepairPhase 'Start-CollabHub'
  try { Invoke-CollabRepairStep -Name 'hub' -ScriptPath (Join-Path $PSScriptRoot 'Start-CollabHub.ps1') -ScriptArguments @('-Quiet') }
  catch { $failures += 'hub'; Write-Warning $_.Exception.Message }
}
if (Test-CollabRunsAgents) {
  foreach ($agent in Get-CollabLocalAgents) {
    Write-RepairPhase "Start-CollabAgent $($agent.id)"
    try { Invoke-CollabRepairStep -Name $agent.id -ScriptPath (Join-Path $PSScriptRoot 'Start-CollabAgent.ps1') -ScriptArguments @('-Agent', $agent.id, '-SkipStatus') }
    catch { $failures += $agent.id; Write-Warning $_.Exception.Message }
  }
}
Write-RepairPhase 'Status-CollabPilot'
try { Invoke-CollabRepairStep -Name 'status' -ScriptPath (Join-Path $PSScriptRoot 'Status-CollabPilot.ps1') }
catch { $failures += 'status'; Write-Warning $_.Exception.Message }
Write-RepairPhase 'repair complete'
if ($failures.Count) { throw "Repair failed for: $($failures -join ', '); other components were still checked" }
