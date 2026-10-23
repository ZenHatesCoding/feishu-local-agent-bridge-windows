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

if ($agentConfig.hermesHook -and $agentConfig.hermesHook.enabled -and (Test-CollabHermesGateway $agentConfig)) {
  Install-CollabAgentHook $agentConfig
  Write-Output "$Agent is already running as a detached Hermes gateway."
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
    if ($agentConfig.hermesHook -and $agentConfig.hermesHook.enabled -and (Test-CollabHermesGateway $agentConfig)) {
      # Hermes hands the gateway to its own service process.  Its short-lived
      # launcher is therefore not a failure and must not trigger hook removal.
      $table = Read-CollabPidTable
      if ($table.Contains($Agent)) { $table.Remove($Agent) }
      Write-CollabPidTable $table
      Write-Output "$Agent started as a detached Hermes gateway."
    } else {
      throw "$Agent launcher exited. See $script:CollabLogDir\$Agent.err.log"
    }
  }
  Write-Output "$Agent started in background (PID $pidValue)."
} catch {
  Stop-CollabComponent $Agent
  Remove-CollabAgentHook $agentConfig
  if ($agentConfig.launch.environment.LARK_CHANNEL_ANTIGRAVITY_TRANSPORT -eq 'desktop') {
    Write-Warning 'Desktop transport failed to start. CLI fallback is disabled; keep the Antigravity App and its Sidecar running.'
  } else {
    Start-OriginalAgent $agentConfig
  }
  throw
}

if (!$SkipStatus) { & (Join-Path $PSScriptRoot 'Status-CollabPilot.ps1') -Agent $Agent }
