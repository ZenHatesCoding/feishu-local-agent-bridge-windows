$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$env:LARK_CHANNEL_HOME = Join-Path $Root ".lark-channel"

node (Join-Path $Root "dist\cli.js") ps
