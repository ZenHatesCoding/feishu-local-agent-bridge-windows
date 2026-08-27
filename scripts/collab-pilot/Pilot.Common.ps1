$script:CollabRepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:CollabStateDir = Join-Path $script:CollabRepoRoot '.runtime'
$script:CollabLogDir = Join-Path $script:CollabStateDir 'logs'
$script:CollabTokenFile = Join-Path $script:CollabStateDir 'hub-token.txt'
$script:CollabAgentTokenFile = Join-Path $script:CollabStateDir 'agent-tokens.json'
$script:CollabTenantFile = Join-Path $script:CollabStateDir 'tenant-key.txt'
$script:CollabConfigFile = Join-Path $script:CollabStateDir 'hub-config.json'
$script:CollabPidFile = Join-Path $script:CollabStateDir 'pids.json'
$script:CollabManifestFile = if ($env:LARK_COLLAB_PILOT_CONFIG) { [IO.Path]::GetFullPath($env:LARK_COLLAB_PILOT_CONFIG) } else { Join-Path $script:CollabStateDir 'pilot.local.json' }

function Expand-CollabValue([object]$Value) {
  if ($null -eq $Value) { return '' }
  $expanded = [string]$Value
  $tokens = @{
    '${REPO_ROOT}' = $script:CollabRepoRoot
    '${STATE_DIR}' = $script:CollabStateDir
    '${USERPROFILE}' = $env:USERPROFILE
    '${LOCALAPPDATA}' = $env:LOCALAPPDATA
  }
  foreach ($token in $tokens.Keys) { $expanded = $expanded.Replace($token, [string]$tokens[$token]) }
  return [Environment]::ExpandEnvironmentVariables($expanded)
}

function Get-CollabPilotConfig {
  if (!(Test-Path -LiteralPath $script:CollabManifestFile)) {
    throw "Pilot config not found: $script:CollabManifestFile`nRun .\scripts\collab-pilot\Setup-CollabPilot.ps1, then edit the generated file."
  }
  $config = Get-Content -LiteralPath $script:CollabManifestFile -Raw | ConvertFrom-Json
  if ([int]$config.schemaVersion -ne 1) { throw 'Unsupported pilot config schemaVersion.' }
  return $config
}

function Get-CollabRole {
  $role = [string](Get-CollabPilotConfig).role
  if (!$role) { return 'all' }
  if ($role -notin @('all', 'hub', 'worker')) { throw "Unsupported pilot role '$role'. Use all, hub, or worker." }
  return $role
}

function Test-CollabRunsHub { return (Get-CollabRole) -in @('all', 'hub') }
function Test-CollabRunsAgents { return (Get-CollabRole) -in @('all', 'worker') }

function Get-CollabAgents([switch]$IncludeDisabled) {
  $agents = @((Get-CollabPilotConfig).agents)
  if ($IncludeDisabled) { return $agents }
  return @($agents | Where-Object { $null -eq $_.enabled -or $_.enabled })
}

function Get-CollabLocalAgents {
  if (!(Test-CollabRunsAgents)) { return @() }
  return @(Get-CollabAgents | Where-Object { $null -eq $_.runOnThisNode -or $_.runOnThisNode })
}

function Get-CollabAgent([string]$Agent) {
  $match = @(Get-CollabLocalAgents | Where-Object { $_.id -eq $Agent })
  if ($match.Count -ne 1) { throw "Unknown, disabled, or non-local agent '$Agent'. Check $script:CollabManifestFile." }
  return $match[0]
}

function Get-CollabRegisteredAgent([string]$Agent) {
  $match = @(Get-CollabAgents | Where-Object { $_.id -eq $Agent })
  if ($match.Count -ne 1) { throw "Unknown or disabled agent '$Agent'. Check $script:CollabManifestFile." }
  return $match[0]
}

function Set-CollabEnvironment([object]$Values) {
  if (!$Values) { return }
  foreach ($property in $Values.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, (Expand-CollabValue $property.Value), 'Process')
  }
}

function Invoke-CollabCommand([object]$Command, [string]$Description) {
  if (!$Command -or !$Command.filePath) { return }
  $filePath = Expand-CollabValue $Command.filePath
  $arguments = @($Command.arguments | ForEach-Object { Expand-CollabValue $_ })
  $workingDirectory = if ($Command.workingDirectory) { Expand-CollabValue $Command.workingDirectory } else { $null }
  Set-CollabEnvironment $Command.environment
  if ($workingDirectory) { Push-Location -LiteralPath $workingDirectory }
  try {
    & $filePath @arguments
    if ($LASTEXITCODE -ne 0 -and !$Command.ignoreExitCode) { throw "$Description failed with exit code $LASTEXITCODE." }
  } finally {
    if ($workingDirectory) { Pop-Location }
  }
}

function Initialize-CollabRuntimeState {
  $pilot = Get-CollabPilotConfig
  New-Item -ItemType Directory -Force -Path $script:CollabStateDir, $script:CollabLogDir | Out-Null
  if (!(Test-CollabRunsHub)) { return }
  if (!(Test-Path -LiteralPath $script:CollabTokenFile)) {
    [IO.File]::WriteAllText($script:CollabTokenFile, [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
  }
  if (!(Test-Path -LiteralPath $script:CollabTenantFile)) {
    $tenantKey = if ($pilot.hub.tenantKey) { [string]$pilot.hub.tenantKey } else { [guid]::NewGuid().ToString('N') }
    [IO.File]::WriteAllText($script:CollabTenantFile, $tenantKey)
  }
  $listenHost = if ($pilot.hub.bindHost) { [string]$pilot.hub.bindHost } elseif ($pilot.hub.host) { [string]$pilot.hub.host } else { '127.0.0.1' }
  $listenPort = if ($pilot.hub.port) { [int]$pilot.hub.port } else { 17321 }
  $hubAgents = @(Get-CollabAgents | ForEach-Object { [ordered]@{ id = $_.id; displayName = $_.displayName; aliases = @($_.aliases) } })
  if ($hubAgents.Count -eq 0) { throw 'Pilot config has no enabled agents.' }
  $savedAgentTokens = [ordered]@{}
  if (Test-Path -LiteralPath $script:CollabAgentTokenFile) {
    $saved = Get-Content -LiteralPath $script:CollabAgentTokenFile -Raw | ConvertFrom-Json
    foreach ($property in $saved.PSObject.Properties) { $savedAgentTokens[$property.Name] = [string]$property.Value }
  }
  foreach ($agent in $hubAgents) {
    if (!$savedAgentTokens[$agent.id]) {
      $savedAgentTokens[$agent.id] = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    }
  }
  [IO.File]::WriteAllText($script:CollabAgentTokenFile, ($savedAgentTokens | ConvertTo-Json))
  $tokenEnvs = [ordered]@{}
  foreach ($agent in $hubAgents) {
    $safeId = ([string]$agent.id).ToUpperInvariant() -replace '[^A-Z0-9]', '_'
    $tokenEnvs[$agent.id] = "LARK_COLLAB_AGENT_TOKEN_$safeId"
  }
  $config = [ordered]@{
    schemaVersion = 1
    listen = [ordered]@{ host = $listenHost; port = $listenPort }
    ledgerPath = 'collaboration.jsonl'
    tokenEnv = 'LARK_COLLAB_HUB_TOKEN'
    auth = [ordered]@{ agentTokenEnvs = $tokenEnvs }
    leaseMinutes = if ($pilot.hub.leaseMinutes) { [int]$pilot.hub.leaseMinutes } else { 30 }
    maxCausalDepth = if ($pilot.hub.maxCausalDepth) { [int]$pilot.hub.maxCausalDepth } elseif ($pilot.hub.maxHops) { [int]$pilot.hub.maxHops } else { 8 }
    agents = $hubAgents
  }
  [IO.File]::WriteAllText($script:CollabConfigFile, ($config | ConvertTo-Json -Depth 8))
}

function Get-CollabHubUrl {
  $hub = (Get-CollabPilotConfig).hub
  if ($hub.publicUrl) { return ([string]$hub.publicUrl).TrimEnd('/') }
  $hostName = if ($hub.host -and $hub.host -ne '0.0.0.0') { $hub.host } else { '127.0.0.1' }
  $port = if ($hub.port) { [int]$hub.port } else { 17321 }
  return "http://${hostName}:$port"
}

function Get-CollabTenantKey {
  $hub = (Get-CollabPilotConfig).hub
  if ($hub.tenantKey) { return [string]$hub.tenantKey }
  if (Test-Path -LiteralPath $script:CollabTenantFile) { return (Get-Content -LiteralPath $script:CollabTenantFile -Raw).Trim() }
  throw 'hub.tenantKey is required on a worker node.'
}

function Get-CollabAgentToken([object]$Agent) {
  if ($Agent.credentialEnv) {
    $value = [Environment]::GetEnvironmentVariable([string]$Agent.credentialEnv, 'Process')
    if (!$value) { throw "Credential environment variable is not set: $($Agent.credentialEnv)" }
    return $value.Trim()
  }
  if ($Agent.credential) { return ([string]$Agent.credential).Trim() }
  if (Test-Path -LiteralPath $script:CollabAgentTokenFile) {
    $tokens = Get-Content -LiteralPath $script:CollabAgentTokenFile -Raw | ConvertFrom-Json
    $property = $tokens.PSObject.Properties[[string]$Agent.id]
    if ($property -and $property.Value) { return ([string]$property.Value).Trim() }
  }
  throw "No Hub credential is configured for agent '$($Agent.id)'."
}

function Test-CollabHubHealth([int]$TimeoutSeconds = 2) {
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
  try {
    $json = $client.GetStringAsync("$(Get-CollabHubUrl)/health").GetAwaiter().GetResult() | ConvertFrom-Json
    return [bool]$json.ok
  } catch {
    return $false
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Read-CollabPidTable {
  $table = [ordered]@{}
  if (!(Test-Path -LiteralPath $script:CollabPidFile)) { return $table }
  $saved = Get-Content -LiteralPath $script:CollabPidFile -Raw | ConvertFrom-Json
  foreach ($property in $saved.PSObject.Properties) { $table[$property.Name] = $property.Value }
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

function Start-CollabBackground([string]$Name, [string]$ScriptPath, [string[]]$ScriptArguments = @()) {
  $table = Read-CollabPidTable
  if (Test-CollabPid $table[$Name]) { Write-Output "$Name is already running (PID $($table[$Name]))."; return [int]$table[$Name] }
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $ScriptArguments
  $process = Start-Process -WindowStyle Hidden -PassThru -FilePath powershell.exe -ArgumentList $arguments `
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
  if (Test-CollabPid $table[$Name]) { Stop-CollabProcessTree -ProcessId ([int]$table[$Name]) }
  if ($table.Contains($Name)) { $table.Remove($Name) }
  Write-CollabPidTable $table
}

function Install-CollabAgentHook([object]$Agent) {
  if (!$Agent.hermesHook -or !$Agent.hermesHook.enabled) { return }
  $hermesHome = Expand-CollabValue $Agent.hermesHook.home
  $target = Join-Path $hermesHome 'hooks\feishu-collaboration-hub'
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item -LiteralPath (Join-Path $script:CollabRepoRoot 'adapters\hermes\HOOK.yaml') -Destination $target -Force
  Copy-Item -LiteralPath (Join-Path $script:CollabRepoRoot 'adapters\hermes\handler.py') -Destination $target -Force
}

function Remove-CollabAgentHook([object]$Agent) {
  if (!$Agent.hermesHook -or !$Agent.hermesHook.enabled) { return }
  $hermesHome = [IO.Path]::GetFullPath((Expand-CollabValue $Agent.hermesHook.home))
  $hooksRoot = [IO.Path]::GetFullPath((Join-Path $hermesHome 'hooks'))
  $target = [IO.Path]::GetFullPath((Join-Path $hooksRoot 'feishu-collaboration-hub'))
  if (!$target.StartsWith($hooksRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe Hook path: $target" }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

function Stop-OriginalAgent([object]$Agent) { Invoke-CollabCommand $Agent.original.stop "Stopping original bridge for $($Agent.id)" }
function Start-OriginalAgent([object]$Agent) { Invoke-CollabCommand $Agent.original.start "Restoring original bridge for $($Agent.id)" }
