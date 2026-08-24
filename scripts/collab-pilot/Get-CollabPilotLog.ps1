param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('hub', 'world', 'justice', 'chariot', 'fool')]
  [string]$Name,
  [ValidateRange(1, 10000)]
  [int]$Tail = 80,
  [switch]$Follow
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

$outFile = Join-Path $script:CollabLogDir "$Name.out.log"
$errFile = Join-Path $script:CollabLogDir "$Name.err.log"
if (!(Test-Path -LiteralPath $outFile) -and !(Test-Path -LiteralPath $errFile)) {
  throw "No logs found for $Name."
}

if ($Follow) {
  Write-Output "Following $outFile (Ctrl+C to stop)..."
  Get-Content -LiteralPath $outFile -Tail $Tail -Wait
} else {
  if (Test-Path -LiteralPath $outFile) {
    Write-Output "--- $Name stdout ---"
    Get-Content -LiteralPath $outFile -Tail $Tail
  }
  if (Test-Path -LiteralPath $errFile) {
    Write-Output "--- $Name stderr ---"
    Get-Content -LiteralPath $errFile -Tail $Tail
  }
}
