param(
  [string]$Config,
  [ValidateRange(5, 300)]
  [int]$PollSeconds = 300
)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

New-Item -ItemType Directory -Force -Path $script:CollabLogDir | Out-Null
$supervisorLog = Join-Path $script:CollabLogDir 'supervisor.log'
$identity = "$script:CollabRepoRoot|$script:CollabManifestFile"
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))) -replace '-', '').Substring(0, 24)
} finally {
  $sha.Dispose()
}
$created = $false
$mutex = [Threading.Mutex]::new($true, "Local\LarkCollaborationPilot-$hash", [ref]$created)
if (!$created) { exit 0 }

function Write-SupervisorLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message$([Environment]::NewLine)"
  [IO.File]::AppendAllText($supervisorLog, $line, [Text.UTF8Encoding]::new($false))
}

function Repair-CollabPilot {
  # Isolate native commands and script exits from the long-lived supervisor.
  $repairScript = Join-Path $PSScriptRoot 'Start-CollabPilot.ps1'
  $repairOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $repairScript -Config $script:CollabManifestFile 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "repair process exited with code ${LASTEXITCODE}: $($repairOutput -join ' | ')"
  }
}

try {
  Write-SupervisorLog "supervisor started pid=$PID config=$script:CollabManifestFile"
  while ($true) {
    try {
      Repair-CollabPilot
    } catch {
      Write-SupervisorLog "repair failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $PollSeconds
  }
} catch {
  Write-SupervisorLog "supervisor fatal: $($_.Exception.Message) at $($_.ScriptStackTrace)"
  # Task Scheduler retries failures, not successful exits.
  exit 1
} finally {
  Write-SupervisorLog "supervisor stopped pid=$PID"
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
