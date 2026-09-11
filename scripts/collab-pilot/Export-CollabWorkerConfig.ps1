param(
  [Parameter(Mandatory = $true)][string]$Agent,
  [Parameter(Mandatory = $true)][string]$HubUrl,
  [string]$OutputPath,
  [string]$Config
)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')

if (!(Test-CollabRunsHub)) { throw 'Worker configs can only be exported from a Hub or all node.' }
Initialize-CollabRuntimeState
$source = Get-CollabRegisteredAgent $Agent
$targetPath = if ($OutputPath) {
  [IO.Path]::GetFullPath($OutputPath)
} else {
  Join-Path $script:CollabStateDir "worker-$Agent.local.json"
}
$targetDir = Split-Path -Parent $targetPath
if (!(Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
$workerAgent = [ordered]@{}
foreach ($property in $source.PSObject.Properties) { $workerAgent[$property.Name] = $property.Value }
$workerAgent['enabled'] = $true
$workerAgent['runOnThisNode'] = $true
$workerAgent['credential'] = Get-CollabAgentToken $source
$pilot = Get-CollabPilotConfig
$worker = [ordered]@{
  schemaVersion = 1
  role = 'worker'
  nodeId = "replace-with-$Agent-node-name"
  hub = [ordered]@{
    publicUrl = $HubUrl.TrimEnd('/')
    tenantKey = Get-CollabTenantKey
  }
  larkCliJs = $pilot.larkCliJs
  commonEnvironment = $pilot.commonEnvironment
  unsetEnvironment = @($pilot.unsetEnvironment)
  agents = @($workerAgent)
}
[IO.File]::WriteAllText($targetPath, ($worker | ConvertTo-Json -Depth 12))
Write-Output "Worker config written: $targetPath"
Write-Warning 'This file contains one Agent credential. Transfer it privately and keep it out of Git.'
