$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$StateDir = Join-Path $RepoRoot '.runtime'
$TokenFile = Join-Path $StateDir 'hub-token.txt'
$ConfigFile = Join-Path $StateDir 'hub-config.json'
$AgentTokenFile = Join-Path $StateDir 'agent-tokens.json'

if (!(Test-Path -LiteralPath $TokenFile) -or !(Test-Path -LiteralPath $ConfigFile)) {
  throw 'Collaboration runtime is not initialized. Run Start-CollabPilot.ps1.'
}

$env:LARK_COLLAB_HUB_TOKEN = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
$agentTokens = Get-Content -LiteralPath $AgentTokenFile -Raw | ConvertFrom-Json
foreach ($property in $agentTokens.PSObject.Properties) {
  $safeId = ([string]$property.Name).ToUpperInvariant() -replace '[^A-Z0-9]', '_'
  [Environment]::SetEnvironmentVariable("LARK_COLLAB_AGENT_TOKEN_$safeId", ([string]$property.Value).Trim(), 'Process')
}
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue

node (Join-Path $RepoRoot 'dist\cli.js') hub run --config $ConfigFile
