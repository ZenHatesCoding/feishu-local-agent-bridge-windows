param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Config,
  [ValidateRange(1, 10000)][int]$Tail = 80,
  [switch]$Follow
)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')
$knownNames = @('hub') + @(Get-CollabAgents | ForEach-Object { $_.id })
if ($knownNames -notcontains $Name) { throw "Unknown component '$Name'." }
$outFile = Join-Path $script:CollabLogDir "$Name.out.log"
$errFile = Join-Path $script:CollabLogDir "$Name.err.log"
if (!(Test-Path -LiteralPath $outFile) -and !(Test-Path -LiteralPath $errFile)) { throw "No logs found for $Name." }
if ($Follow) {
  Write-Output "Following $outFile (Ctrl+C to stop)..."
  Get-Content -LiteralPath $outFile -Tail $Tail -Wait
} else {
  if (Test-Path -LiteralPath $outFile) { Write-Output "--- $Name stdout ---"; Get-Content -LiteralPath $outFile -Tail $Tail }
  if (Test-Path -LiteralPath $errFile) { Write-Output "--- $Name stderr ---"; Get-Content -LiteralPath $errFile -Tail $Tail }
}
