param([string]$Agent, [string]$Config)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

$health = try { (Invoke-RestMethod -Uri "$(Get-CollabHubUrl)/health" -TimeoutSec 2).ok } catch { $false }
Write-Output "Hub health: $health"
$pids = Read-CollabPidTable
$knownNames = @('hub') + @(Get-CollabAgents | ForEach-Object { $_.id })
if ($Agent -and $knownNames -notcontains $Agent) { throw "Unknown component '$Agent'." }
$names = if ($Agent) { @($Agent) } else { $knownNames }
foreach ($name in $names) {
  $pidValue = if ($pids[$name]) { [int]$pids[$name] } else { 0 }
  $process = if ($pidValue -gt 0) { Get-Process -Id $pidValue -ErrorAction SilentlyContinue } else { $null }
  $children = if ($process) { @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$pidValue" -ErrorAction SilentlyContinue) } else { @() }
  $errFile = Join-Path $script:CollabLogDir "$name.err.log"
  $lastError = if (Test-Path -LiteralPath $errFile) { (Get-Content -LiteralPath $errFile -Tail 3 -ErrorAction SilentlyContinue) -join ' | ' } else { '' }
  [pscustomobject]@{ Name = $name; PID = $pidValue; Running = [bool]$process; Worker = ($children.Name -join ','); LastError = $lastError }
}
