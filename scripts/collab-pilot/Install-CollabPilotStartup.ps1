param(
  [string]$Config,
  [string]$TaskName,
  # One task per agent: -Agent switches the action from the whole-pilot polling
  # supervisor to the per-agent event-driven one (see Run-CollabAgentSupervisor.ps1).
  [string]$Agent,
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$configPath = if ($Config) { [IO.Path]::GetFullPath($Config) } else { Join-Path $repoRoot '.runtime\pilot.local.json' }
if (!(Test-Path -LiteralPath $configPath)) { throw "Pilot config not found: $configPath" }
if (!$TaskName) {
  $TaskName = if ($Agent) { "Lark Collaboration Agent $Agent" } else { 'Lark Collaboration Pilot' }
}

$supervisor = if ($Agent) {
  [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Run-CollabAgentSupervisor.ps1'))
} else {
  [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Run-CollabPilotSupervisor.ps1'))
}
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
if ($Agent) { $argument += " -Agent `"$Agent`"" }
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
  # Only stop what this task owns: a per-agent task must not take the whole pilot
  # (or a sibling agent on the same box) down with it. Both paths pass the same
  # manifest the task is being registered for.
  if ($Agent) { & (Join-Path $PSScriptRoot 'Stop-CollabAgent.ps1') -Agent $Agent -Config $configPath }
  else { & (Join-Path $PSScriptRoot 'Stop-CollabPilot.ps1') -Config $configPath }
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Started Windows startup task: $TaskName"
} elseif ($wasRunning) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Restarted Windows startup task: $TaskName"
}
