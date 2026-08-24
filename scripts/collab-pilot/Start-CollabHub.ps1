param([string]$Config, [switch]$Quiet)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

Initialize-CollabRuntimeState
$table = Read-CollabPidTable
if (Test-CollabPid $table['hub']) {
  if (!$Quiet) { Write-Output "Hub is already running (PID $($table['hub']))." }
  return
}

$healthUrl = "$(Get-CollabHubUrl)/health"
$existingHealth = try {
  (Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1).ok
} catch { $false }
if ($existingHealth) {
  throw 'Port 17321 already has a healthy Hub that is not owned by this PID file.'
}

$pidValue = Start-CollabBackground -Name 'hub' -ScriptPath (Join-Path $PSScriptRoot 'run-hub.ps1')
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 250
  $healthy = try {
    (Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1).ok
  } catch { $false }
  if ($healthy) {
    if (!$Quiet) { Write-Output "Hub started in background (PID $pidValue)." }
    return
  }
}

Stop-CollabComponent 'hub'
throw "Hub failed to become healthy. See $script:CollabLogDir\hub.err.log"
