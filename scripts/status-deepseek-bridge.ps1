$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$env:LARK_CHANNEL_HOME = Join-Path $Root '.lark-channel-deepseek'
node (Join-Path $Root 'dist\cli.js') ps
