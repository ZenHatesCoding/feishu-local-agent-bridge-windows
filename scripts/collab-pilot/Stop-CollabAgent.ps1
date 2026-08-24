param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('world', 'justice', 'chariot', 'fool')]
  [string]$Agent,
  [switch]$RestoreOriginal
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

# Let each bridge clear its own registry and locks first. The tracked launcher
# process is then terminated as a fallback if the bridge control did not exit it.
Stop-OriginalAgent $Agent
Stop-CollabComponent $Agent
if ($Agent -eq 'fool') { Remove-CollabHermesHook }
Write-Output "$Agent collaboration bridge stopped."

if ($RestoreOriginal) {
  Start-OriginalAgent $Agent
  Write-Output "$Agent original bridge restored."
}
