$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$StateDir = Join-Path $RepoRoot '.runtime'
$LogDir = Join-Path $StateDir 'logs'
$TokenFile = Join-Path $StateDir 'hub-token.txt'
$TenantFile = Join-Path $StateDir 'tenant-key.txt'
$ConfigFile = Join-Path $StateDir 'hub-config.json'
$PidFile = Join-Path $StateDir 'pids.json'
$HermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
$HermesPython = Join-Path $HermesHome 'hermes-agent\venv\Scripts\python.exe'
$HermesHook = Join-Path $HermesHome 'hooks\feishu-collaboration-hub'

New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null

if (!(Test-Path -LiteralPath $TokenFile)) {
  $token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  [IO.File]::WriteAllText($TokenFile, $token)
}
if (!(Test-Path -LiteralPath $TenantFile)) {
  [IO.File]::WriteAllText($TenantFile, 'zhenping-feishu-collab-v1')
}

$config = [ordered]@{
  schemaVersion = 1
  listen = [ordered]@{ host = '127.0.0.1'; port = 17321 }
  ledgerPath = 'collaboration.jsonl'
  tokenEnv = 'LARK_COLLAB_HUB_TOKEN'
  leaseMinutes = 30
  maxHops = 8
  agents = @(
    [ordered]@{ id = 'world'; displayName = 'World'; aliases = @('codex') }
    [ordered]@{ id = 'justice'; displayName = 'Justice'; aliases = @('antigravity') }
    [ordered]@{ id = 'chariot'; displayName = 'Chariot'; aliases = @('deepseek') }
    [ordered]@{ id = 'fool'; displayName = 'Fool'; aliases = @('hermes') }
  )
}
[IO.File]::WriteAllText($ConfigFile, ($config | ConvertTo-Json -Depth 8))

# Install only the additive collaboration hook. Hermes source, venv, config,
# sessions, memories, and skills are left untouched.
New-Item -ItemType Directory -Force -Path $HermesHook | Out-Null
Copy-Item -LiteralPath (Join-Path $RepoRoot 'adapters\hermes\HOOK.yaml') -Destination $HermesHook -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot 'adapters\hermes\handler.py') -Destination $HermesHook -Force

# Stop the original listeners through their own controls before starting the
# pilot against the same credential/session homes.
& C:\codex-bridge\stop-codex-bridge.ps1
& C:\antigravity-bridge\scripts\stop-antigravity-bridge-service.ps1
& C:\deepseek-bridge\scripts\stop-deepseek-bridge-service.ps1
& $HermesPython -c "import sys; from hermes_cli.main import main; sys.argv=['hermes','gateway','stop']; main()"
Start-Sleep -Seconds 2

$launchers = [ordered]@{
  hub = @('run-hub.ps1')
  world = @('run-agent.ps1', '-Agent', 'world')
  justice = @('run-agent.ps1', '-Agent', 'justice')
  chariot = @('run-agent.ps1', '-Agent', 'chariot')
  fool = @('run-agent.ps1', '-Agent', 'fool')
}
$pids = [ordered]@{}
foreach ($name in $launchers.Keys) {
  $script = Join-Path $PSScriptRoot $launchers[$name][0]
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script) + $launchers[$name][1..($launchers[$name].Count - 1)]
  if ($launchers[$name].Count -eq 1) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script)
  }
  $process = Start-Process -WindowStyle Hidden -PassThru `
    -FilePath powershell.exe `
    -ArgumentList $arguments `
    -RedirectStandardOutput (Join-Path $LogDir "$name.out.log") `
    -RedirectStandardError (Join-Path $LogDir "$name.err.log")
  $pids[$name] = $process.Id
  if ($name -eq 'hub') { Start-Sleep -Seconds 2 }
}
$pids['startedAt'] = [DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($PidFile, ($pids | ConvertTo-Json))
Start-Sleep -Seconds 6
& (Join-Path $PSScriptRoot 'Status-CollabPilot.ps1')
