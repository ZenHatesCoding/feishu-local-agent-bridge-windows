$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "deepseek-harness-env.ps1")
Initialize-DeepSeekHarnessEnvironment -Root $Root

$AppId = Read-Host "Paste the App ID from Feishu Basic Information"
if ([string]::IsNullOrWhiteSpace($AppId)) { throw "App ID is required" }

$Workspace = Join-Path $Root "workspace"
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null

node (Join-Path $Root "dist\cli.js") profile create deepseek `
  --agent antigravity `
  --workspace $Workspace `
  --app-id $AppId `
  --tenant feishu
