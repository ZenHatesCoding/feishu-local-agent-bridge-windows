param(
  [Parameter(Mandatory = $true)]
  [string]$Agent,
  [string]$Config,
  [switch]$SkipStatus
)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')
$agentConfig = Get-CollabAgent $Agent

# If the credential env var is not yet in Process scope, lift it from User scope.
# Task Scheduler already does this; this makes `Start-CollabAgent.ps1` work the
# same way from an interactive PowerShell where User-level vars are not auto-
# promoted to Process-level.
if ($agentConfig.credentialEnv -and -not [Environment]::GetEnvironmentVariable([string]$agentConfig.credentialEnv, 'Process')) {
  $userValue = [Environment]::GetEnvironmentVariable([string]$agentConfig.credentialEnv, 'User')
  if ($userValue) {
    [Environment]::SetEnvironmentVariable([string]$agentConfig.credentialEnv, $userValue, 'Process')
  }
}

Initialize-CollabRuntimeState
if (Test-CollabRunsHub) {
  & (Join-Path $PSScriptRoot 'Start-CollabHub.ps1') -Quiet
} else {
  $healthy = Test-CollabHubHealth -TimeoutSeconds 3
  if (!$healthy) { throw "Remote Hub is unavailable: $(Get-CollabHubUrl)" }
}
$table = Read-CollabPidTable
if (Test-CollabPid $table[$Agent]) {
  Write-Output "$Agent is already running (PID $($table[$Agent]))."
  if (!$SkipStatus) { & (Join-Path $PSScriptRoot 'Status-CollabPilot.ps1') -Agent $Agent }
  return
}

Stop-OriginalAgent $agentConfig
Install-CollabAgentHook $agentConfig

try {
  $pidValue = Start-CollabBackground `
    -Name $Agent `
    -ScriptPath (Join-Path $PSScriptRoot 'run-agent.ps1') `
    -ScriptArguments @('-Agent', $Agent)
  Start-Sleep -Seconds 4
  if (!(Test-CollabPid $pidValue)) {
    throw "$Agent launcher exited. See $script:CollabLogDir\$Agent.err.log"
  }
  Write-Output "$Agent started in background (PID $pidValue)."
} catch {
  Stop-CollabComponent $Agent
  Remove-CollabAgentHook $agentConfig
  Start-OriginalAgent $agentConfig
  throw
}

if (!$SkipStatus) { & (Join-Path $PSScriptRoot 'Status-CollabPilot.ps1') -Agent $Agent }
