$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$HarnessRoot = "C:\Users\ZhenpingXing\Documents\Codex\2026-08-14\git-clone-https-github-com-deepseek\deepseek-harness"
$env:LARK_CHANNEL_HOME = Join-Path $Root ".lark-channel"
$env:LARK_CHANNEL_ANTIGRAVITY_BIN = (Get-Command node).Source
$env:LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY = Join-Path $HarnessRoot "apps\cli\lib\bin.js"
$env:LARK_CHANNEL_DISABLE_PROXY = "1"
$env:PATH = "$(Join-Path $Root "bin");$env:PATH"
Remove-Item Env:HERMES_HOME -ErrorAction SilentlyContinue
Remove-Item Env:HERMES_GIT_BASH_PATH -ErrorAction SilentlyContinue

$AppId = Read-Host "Paste the App ID from Feishu Basic Information"
if ([string]::IsNullOrWhiteSpace($AppId)) { throw "App ID is required" }

$Workspace = Join-Path $Root "workspace"
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null

node (Join-Path $Root "dist\cli.js") profile create deepseek `
  --agent antigravity `
  --workspace $Workspace `
  --app-id $AppId `
  --tenant feishu
