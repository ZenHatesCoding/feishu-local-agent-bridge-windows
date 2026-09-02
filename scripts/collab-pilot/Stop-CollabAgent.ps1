param(
  [Parameter(Mandatory = $true)]
  [string]$Agent,
  [string]$Config,
  [switch]$RestoreOriginal
)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')
$agentConfig = Get-CollabAgent $Agent

# Let each bridge clear its own registry and locks first. The tracked launcher
# process is then terminated as a fallback if the bridge control did not exit it.
Stop-CollabRegisteredBridge $agentConfig
Stop-CollabComponent $Agent
Remove-CollabAgentHook $agentConfig
Write-Output "$Agent collaboration bridge stopped."

if ($RestoreOriginal) {
  Start-OriginalAgent $agentConfig
  Write-Output "$Agent original bridge restored."
}
