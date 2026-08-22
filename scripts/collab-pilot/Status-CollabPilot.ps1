$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$StateDir = Join-Path $RepoRoot '.runtime'
$PidFile = Join-Path $StateDir 'pids.json'
$LogDir = Join-Path $StateDir 'logs'

$health = try {
  (Invoke-RestMethod -Uri 'http://127.0.0.1:17321/health' -TimeoutSec 2).ok
} catch {
  $false
}
Write-Output "Hub health: $health"

if (!(Test-Path -LiteralPath $PidFile)) {
  Write-Output 'No pilot PID file.'
  exit 1
}
$pids = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
foreach ($name in 'hub', 'world', 'justice', 'chariot', 'fool') {
  $pidValue = [int]$pids.$name
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  $errFile = Join-Path $LogDir "$name.err.log"
  $lastError = if (Test-Path -LiteralPath $errFile) {
    (Get-Content -LiteralPath $errFile -Tail 3 -ErrorAction SilentlyContinue) -join ' | '
  } else { '' }
  [pscustomobject]@{
    Name = $name
    PID = $pidValue
    Running = [bool]$process
    LastError = $lastError
  }
}
