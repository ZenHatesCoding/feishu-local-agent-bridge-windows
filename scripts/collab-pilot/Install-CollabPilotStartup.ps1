param(
  [string]$Config,
  [string]$TaskName = 'Lark Collaboration Pilot',
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$configPath = if ($Config) { [IO.Path]::GetFullPath($Config) } else { Join-Path $repoRoot '.runtime\pilot.local.json' }
if (!(Test-Path -LiteralPath $configPath)) { throw "Pilot config not found: $configPath" }

$supervisor = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Run-CollabPilotSupervisor.ps1'))
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$wasRunning = $existingTask -and $existingTask.State -eq 'Running'
if ($wasRunning) {
  Stop-ScheduledTask -TaskName $TaskName
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') { break }
    Start-Sleep -Milliseconds 250
  }
  if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') {
    throw "Timed out stopping existing Windows startup task: $TaskName"
  }
}
$argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisor`" -Config `"$configPath`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Keeps the Feishu collaboration Hub and local bots online independently of interactive terminals.' -Force | Out-Null
Write-Output "Installed Windows startup task: $TaskName"

if ($StartNow) {
  & (Join-Path $PSScriptRoot 'Stop-CollabPilot.ps1')
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Started Windows startup task: $TaskName"
} elseif ($wasRunning) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Restarted Windows startup task: $TaskName"
}
