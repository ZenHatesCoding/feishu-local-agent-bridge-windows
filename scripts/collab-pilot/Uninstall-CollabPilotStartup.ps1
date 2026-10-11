param(
  [string]$TaskName = 'Lark Collaboration Pilot',
  [string]$Config,
  [switch]$KeepPilotRunning
)

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (!$task) {
  Write-Output "Windows startup task is not installed: $TaskName"
  exit 0
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  if ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') { break }
  Start-Sleep -Milliseconds 250
}
if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') {
  throw "Timed out stopping Windows startup task: $TaskName"
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
if (!$KeepPilotRunning) {
  # Forward the manifest the task was registered for; without it the stop would
  # act on whatever LARK_COLLAB_PILOT_CONFIG / .runtime\pilot.local.json names.
  if ($Config) { & (Join-Path $PSScriptRoot 'Stop-CollabPilot.ps1') -Config $Config }
  else { & (Join-Path $PSScriptRoot 'Stop-CollabPilot.ps1') }
}
Write-Output "Uninstalled Windows startup task: $TaskName"
