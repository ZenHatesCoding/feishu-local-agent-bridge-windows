param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('world', 'justice', 'chariot', 'fool')]
  [string]$Agent,
  [switch]$SkipStatus
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

& (Join-Path $PSScriptRoot 'Start-CollabHub.ps1') -Quiet
$table = Read-CollabPidTable
if (Test-CollabPid $table[$Agent]) {
  Write-Output "$Agent is already running (PID $($table[$Agent]))."
  if (!$SkipStatus) { & (Join-Path $PSScriptRoot 'Status-CollabPilot.ps1') -Agent $Agent }
  return
}

Stop-OriginalAgent $Agent
if ($Agent -eq 'fool') { Install-CollabHermesHook }

try {
  $pidValue = Start-CollabBackground `
    -Name $Agent `
    -ScriptPath (Join-Path $PSScriptRoot 'run-agent.ps1') `
    -ScriptArguments @('-Agent', $Agent)
  Start-Sleep -Seconds 4
  if (!(Test-CollabPid $pidValue)) {
    throw "$Agent launcher exited. See $script:CollabLogDir\$Agent.err.log"
  }
  Write-Output "$Agent started in background (PID $pidValue)."
} catch {
  Stop-CollabComponent $Agent
  if ($Agent -eq 'fool') { Remove-CollabHermesHook }
  Start-OriginalAgent $Agent
  throw
}

if (!$SkipStatus) { & (Join-Path $PSScriptRoot 'Status-CollabPilot.ps1') -Agent $Agent }
