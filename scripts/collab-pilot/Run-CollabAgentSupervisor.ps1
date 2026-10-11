<#
.SYNOPSIS
  Keeps exactly one collaboration agent alive on this machine, event-driven.

.DESCRIPTION
  Same job as Run-CollabPilotSupervisor.ps1 (keep the agent's bridge up, wait for
  the remote Hub, restart it after a crash), but scoped to ONE agent and blocking
  in Wait-Process instead of polling:

    - while the bridge is healthy this process is fully idle (no 15s wake-ups),
    - it only runs when it has something to do:
        * waiting (with backoff) while the Hub is unreachable,
        * waiting (slowly retrying) while the agent credential is missing,
        * (re)starting the agent after its launcher exits.

  One manifest + one task per agent: on a machine that runs several agents
  (`sun`, `moon`, …) register this script once per agent with -Agent and -Config.
  It never duplicates launch logic - it calls Start-CollabAgent.ps1, which owns
  the credential lift, the Hub check, the Hermes hook handling and the tracked
  background launcher (run-agent.ps1, which sets the per-agent journal root).

  Because a hard-killed bridge leaves its CLI registration behind (and the next
  start then refuses with "当前 profile 已有 bridge 进程占用"), every start first
  clears both sides for THIS agent only:
    Stop-CollabComponent      -> tracked launcher tree from pids.json
    Stop-CollabRegisteredBridge -> bridge's own registry, resolved under the
                                   agent's LARK_CHANNEL_HOME

.EXAMPLE
  .\Run-CollabAgentSupervisor.ps1 -Agent moon -Config .\.runtime\worker-moon.local.json
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Agent,
  [string]$Config,
  [ValidateRange(1, 300)]
  [int]$RestartSeconds = 5,
  [ValidateRange(1, 60)]
  [int]$CredentialRetrySeconds = 60,
  # A detached Hermes gateway has no launcher PID to wait on, so its health can
  # only be re-checked on a timer; every other engine stays fully event-driven.
  [ValidateRange(10, 600)]
  [int]$GatewayCheckSeconds = 60
)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

New-Item -ItemType Directory -Force -Path $script:CollabLogDir | Out-Null
$supervisorLog = Join-Path $script:CollabLogDir "$Agent-supervisor.log"
$agentConfig = Get-CollabAgent $Agent
$startAgent = Join-Path $PSScriptRoot 'Start-CollabAgent.ps1'

function Write-SupervisorLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message$([Environment]::NewLine)"
  [IO.File]::AppendAllText($supervisorLog, $line, [Text.UTF8Encoding]::new($false))
}

# Task Scheduler promotes User-scope variables into Process scope; a manual start
# must behave the same, otherwise the supervisor waits for a credential that is
# already configured.
function Import-CredentialFromUserScope {
  if (!$agentConfig.credentialEnv) { return }
  $name = [string]$agentConfig.credentialEnv
  if ([Environment]::GetEnvironmentVariable($name, 'Process')) { return }
  $userValue = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($userValue) { [Environment]::SetEnvironmentVariable($name, $userValue, 'Process') }
}

# All three credential sources count, not just the environment variable: the
# inline `credential` and `.runtime\agent-tokens.json` are valid configurations
# too, and a supervisor that only looked at credentialEnv would wait forever on a
# correctly configured agent. Get-CollabAgentToken owns the precedence.
function Test-CredentialReady {
  try { $null = Get-CollabAgentToken $agentConfig; return $true } catch { return $false }
}

# A detached Hermes gateway is healthy even though its short-lived launcher has
# exited and no launcher PID remains in the pid table; restarting it every few
# seconds would fight the user's own service.
function Test-DetachedHermesGateway {
  if (!$agentConfig.hermesHook -or !$agentConfig.hermesHook.enabled) { return $false }
  return (Test-CollabHermesGateway $agentConfig)
}

function Clear-AgentRuntime {
  Stop-CollabComponent $Agent
  Stop-CollabRegisteredBridge $agentConfig
}

Write-SupervisorLog "supervisor started pid=$PID agent=$Agent mode=event-driven manifest=$script:CollabManifestFile"

$hubBackoffSeconds = 10
while ($true) {
  Import-CredentialFromUserScope

  if (!(Test-CredentialReady)) {
    Write-SupervisorLog "credential '$($agentConfig.credentialEnv)' not set; retry in ${CredentialRetrySeconds}s"
    Start-Sleep -Seconds $CredentialRetrySeconds
    continue
  }

  if (-not (Test-CollabHubHealth -TimeoutSeconds 3)) {
    Write-SupervisorLog "hub unreachable; next probe in ${hubBackoffSeconds}s"
    Start-Sleep -Seconds $hubBackoffSeconds
    if ($hubBackoffSeconds -lt 60) { $hubBackoffSeconds = [Math]::Min(60, $hubBackoffSeconds * 2) }
    continue
  }
  $hubBackoffSeconds = 10

  try {
    Clear-AgentRuntime
    & $startAgent -Agent $Agent -SkipStatus | ForEach-Object { Write-SupervisorLog "start: $_" }
  } catch {
    Write-SupervisorLog "start failed: $($_.Exception.Message); retry in ${RestartSeconds}s"
    Start-Sleep -Seconds $RestartSeconds
    continue
  }

  $launcherPid = (Read-CollabPidTable)[$Agent]
  if (!(Test-CollabPid $launcherPid)) {
    if (Test-DetachedHermesGateway) {
      Write-SupervisorLog "detached Hermes gateway is healthy; next check in ${GatewayCheckSeconds}s"
      Start-Sleep -Seconds $GatewayCheckSeconds
      continue
    }
    Write-SupervisorLog "launcher for $Agent is not running; retry in ${RestartSeconds}s"
    Start-Sleep -Seconds $RestartSeconds
    continue
  }

  Write-SupervisorLog "agent launcher pid=$launcherPid; idle until it exits"
  Wait-Process -Id ([int]$launcherPid) -ErrorAction SilentlyContinue
  Write-SupervisorLog "agent launcher pid=$launcherPid exited; restart in ${RestartSeconds}s"
  Start-Sleep -Seconds $RestartSeconds
}
