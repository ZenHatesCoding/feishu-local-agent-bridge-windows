$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$env:LARK_CHANNEL_HOME = Join-Path $Root ".lark-channel"
$env:LARK_CHANNEL_ANTIGRAVITY_BIN = Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"
$env:LARK_CHANNEL_DISABLE_PROXY = "1"
$env:PATH = "$(Join-Path $Root "bin");$env:PATH"
Remove-Item Env:HERMES_HOME -ErrorAction SilentlyContinue
Remove-Item Env:HERMES_GIT_BASH_PATH -ErrorAction SilentlyContinue

$Workspace = Join-Path $Root "workspace"
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null

node (Join-Path $Root "dist\cli.js") start `
  --profile antigravity `
  --agent antigravity `
  --workspace $Workspace `
  @args
