$script:CollabRepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:CollabStateDir = Join-Path $script:CollabRepoRoot '.runtime'
$script:CollabLogDir = Join-Path $script:CollabStateDir 'logs'
$script:CollabTokenFile = Join-Path $script:CollabStateDir 'hub-token.txt'
$script:CollabTenantFile = Join-Path $script:CollabStateDir 'tenant-key.txt'
$script:CollabConfigFile = Join-Path $script:CollabStateDir 'hub-config.json'
$script:CollabPidFile = Join-Path $script:CollabStateDir 'pids.json'
$script:CollabHermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
$script:CollabHermesPython = Join-Path $script:CollabHermesHome 'hermes-agent\venv\Scripts\python.exe'
$script:CollabHermesHook = Join-Path $script:CollabHermesHome 'hooks\feishu-collaboration-hub'

function Initialize-CollabRuntimeState {
  New-Item -ItemType Directory -Force -Path $script:CollabStateDir, $script:CollabLogDir | Out-Null

  if (!(Test-Path -LiteralPath $script:CollabTokenFile)) {
    $token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    [IO.File]::WriteAllText($script:CollabTokenFile, $token)
  }
  if (!(Test-Path -LiteralPath $script:CollabTenantFile)) {
    [IO.File]::WriteAllText($script:CollabTenantFile, 'zhenping-feishu-collab-v1')
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
  [IO.File]::WriteAllText($script:CollabConfigFile, ($config | ConvertTo-Json -Depth 8))
}

function Read-CollabPidTable {
  $table = [ordered]@{}
  if (!(Test-Path -LiteralPath $script:CollabPidFile)) { return $table }
  $saved = Get-Content -LiteralPath $script:CollabPidFile -Raw | ConvertFrom-Json
  foreach ($property in $saved.PSObject.Properties) {
    $table[$property.Name] = $property.Value
  }
  return $table
}

function Write-CollabPidTable([Collections.IDictionary]$Table) {
  $Table['updatedAt'] = [DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText($script:CollabPidFile, ($Table | ConvertTo-Json))
}

function Test-CollabPid([object]$ProcessId) {
  if (!$ProcessId) { return $false }
  return [bool](Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue)
}

function Start-CollabBackground(
  [string]$Name,
  [string]$ScriptPath,
  [string[]]$ScriptArguments = @()
) {
  $table = Read-CollabPidTable
  if (Test-CollabPid $table[$Name]) {
    Write-Output "$Name is already running (PID $($table[$Name]))."
    return [int]$table[$Name]
  }

  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $ScriptArguments
  $process = Start-Process -WindowStyle Hidden -PassThru `
    -FilePath powershell.exe `
    -ArgumentList $arguments `
    -RedirectStandardOutput (Join-Path $script:CollabLogDir "$Name.out.log") `
    -RedirectStandardError (Join-Path $script:CollabLogDir "$Name.err.log")
  $table[$Name] = $process.Id
  Write-CollabPidTable $table
  return $process.Id
}

function Stop-CollabProcessTree([int]$ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) { Stop-CollabProcessTree -ProcessId $child.ProcessId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-CollabComponent([string]$Name) {
  $table = Read-CollabPidTable
  if (Test-CollabPid $table[$Name]) {
    Stop-CollabProcessTree -ProcessId ([int]$table[$Name])
  }
  if ($table.Contains($Name)) { $table.Remove($Name) }
  Write-CollabPidTable $table
}

function Install-CollabHermesHook {
  New-Item -ItemType Directory -Force -Path $script:CollabHermesHook | Out-Null
  Copy-Item -LiteralPath (Join-Path $script:CollabRepoRoot 'adapters\hermes\HOOK.yaml') -Destination $script:CollabHermesHook -Force
  Copy-Item -LiteralPath (Join-Path $script:CollabRepoRoot 'adapters\hermes\handler.py') -Destination $script:CollabHermesHook -Force
}

function Remove-CollabHermesHook {
  if (!(Test-Path -LiteralPath $script:CollabHermesHook)) { return }
  $target = [IO.Path]::GetFullPath($script:CollabHermesHook)
  $hooksRoot = [IO.Path]::GetFullPath((Join-Path $script:CollabHermesHome 'hooks'))
  if (!$target.StartsWith($hooksRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove Hook outside Hermes hooks directory: $target"
  }
  Remove-Item -LiteralPath $target -Recurse -Force
}

function Invoke-CollabPowerShellScript([string]$Path) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Path
  if ($LASTEXITCODE -ne 0) {
    throw "PowerShell script failed with exit code $LASTEXITCODE`: $Path"
  }
}

function Stop-OriginalAgent([string]$Agent) {
  switch ($Agent) {
    'world' { Invoke-CollabPowerShellScript 'C:\codex-bridge\stop-codex-bridge.ps1' }
    'justice' { Invoke-CollabPowerShellScript 'C:\antigravity-bridge\scripts\stop-antigravity-bridge-service.ps1' }
    'chariot' { Invoke-CollabPowerShellScript 'C:\deepseek-bridge\scripts\stop-deepseek-bridge-service.ps1' }
    'fool' { & $script:CollabHermesPython -c "import sys; from hermes_cli.main import main; sys.argv=['hermes','gateway','stop']; main()" }
    default { throw "Unknown agent: $Agent" }
  }
}

function Start-OriginalAgent([string]$Agent) {
  switch ($Agent) {
    'world' { Invoke-CollabPowerShellScript 'C:\codex-bridge\start-codex-bridge.ps1' }
    'justice' { Invoke-CollabPowerShellScript 'C:\antigravity-bridge\scripts\start-antigravity-bridge-service.ps1' }
    'chariot' { Invoke-CollabPowerShellScript 'C:\deepseek-bridge\scripts\start-deepseek-bridge-service.ps1' }
    'fool' { & $script:CollabHermesPython -c "import sys; from hermes_cli.main import main; sys.argv=['hermes','gateway','start']; main()" }
    default { throw "Unknown agent: $Agent" }
  }
}
