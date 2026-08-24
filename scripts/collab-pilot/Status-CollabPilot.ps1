param(
  [ValidateSet('hub', 'world', 'justice', 'chariot', 'fool')]
  [string]$Agent
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

$health = try {
  (Invoke-RestMethod -Uri 'http://127.0.0.1:17321/health' -TimeoutSec 2).ok
} catch {
  $false
}
Write-Output "Hub health: $health"

if (!(Test-Path -LiteralPath $script:CollabPidFile)) {
  Write-Output 'No pilot PID file.'
  exit 1
}
$pids = Read-CollabPidTable
$names = if ($Agent) { @($Agent) } else { @('hub', 'world', 'justice', 'chariot', 'fool') }
foreach ($name in $names) {
  $pidValue = if ($pids[$name]) { [int]$pids[$name] } else { 0 }
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  $children = if ($process) {
    @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$pidValue" -ErrorAction SilentlyContinue)
  } else { @() }
  $errFile = Join-Path $script:CollabLogDir "$name.err.log"
  $lastError = if (Test-Path -LiteralPath $errFile) {
    (Get-Content -LiteralPath $errFile -Tail 3 -ErrorAction SilentlyContinue) -join ' | '
  } else { '' }
  [pscustomobject]@{
    Name = $name
    PID = $pidValue
    Running = [bool]$process
    Worker = ($children.Name -join ',')
    LastError = $lastError
  }
}
