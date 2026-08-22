$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$StateDir = Join-Path $RepoRoot '.runtime'
$TokenFile = Join-Path $StateDir 'hub-token.txt'
$ConfigFile = Join-Path $StateDir 'hub-config.json'

if (!(Test-Path -LiteralPath $TokenFile) -or !(Test-Path -LiteralPath $ConfigFile)) {
  throw 'Collaboration runtime is not initialized. Run Start-CollabPilot.ps1.'
}

$env:LARK_COLLAB_HUB_TOKEN = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue

node (Join-Path $RepoRoot 'dist\cli.js') hub run --config $ConfigFile
