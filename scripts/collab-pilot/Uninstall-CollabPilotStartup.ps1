param(
  [string]$TaskName = 'Lark Collaboration Pilot',
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
if (!$KeepPilotRunning) { & (Join-Path $PSScriptRoot 'Stop-CollabPilot.ps1') }
Write-Output "Uninstalled Windows startup task: $TaskName"
