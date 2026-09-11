$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'deepseek-harness-env.ps1')
Initialize-DeepSeekHarnessEnvironment -Root $Root
$Workspace = Join-Path $Root 'workspace-deepseek'
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
node (Join-Path $Root 'dist\cli.js') run --profile deepseek --agent deepseek-harness --workspace $Workspace @args
