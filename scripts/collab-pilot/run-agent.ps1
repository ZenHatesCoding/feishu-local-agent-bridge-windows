param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('world', 'justice', 'chariot', 'fool')]
  [string]$Agent
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$StateDir = Join-Path $RepoRoot '.runtime'
$TokenFile = Join-Path $StateDir 'hub-token.txt'
$TenantFile = Join-Path $StateDir 'tenant-key.txt'
$CommandDir = Join-Path $RepoRoot 'scripts\collab-pilot\bin'

$env:LARK_COLLAB_HUB_URL = 'http://127.0.0.1:17321'
$env:LARK_COLLAB_HUB_TOKEN = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
$env:LARK_COLLAB_TENANT_KEY = (Get-Content -LiteralPath $TenantFile -Raw).Trim()
$env:LARK_COLLAB_AGENT_ID = $Agent
$env:LARK_COLLAB_EVENT_SOURCE = 'distributed'
$env:LARK_COLLAB_ARTIFACT_ROOT = Join-Path $StateDir 'artifacts'
$env:LARK_COLLAB_COMMAND_DIR = $CommandDir
$env:LARK_COLLAB_REAL_LARK_CLI_JS = 'C:\Users\ZhenpingXing\.trae-cn\binaries\node\versions\24.14.0\node_modules\@larksuite\cli\scripts\run.js'
$env:PATH = "$CommandDir;$env:PATH"
$env:LARK_CHANNEL_DISABLE_PROXY = '1'
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HERMES_HOME -ErrorAction SilentlyContinue
Remove-Item Env:HERMES_GIT_BASH_PATH -ErrorAction SilentlyContinue
Remove-Item Env:TERM -ErrorAction SilentlyContinue

switch ($Agent) {
  'world' {
    $env:LARK_CHANNEL_HOME = Join-Path $env:USERPROFILE '.lark-channel'
    $env:LARK_CHANNEL_CODEX_BIN = 'C:\Users\ZhenpingXing\.trae-cn\binaries\node\versions\24.14.0\codex.cmd'
    node C:\collab-runtime\codex\dist\cli.js run --profile codex
  }
  'justice' {
    $env:LARK_CHANNEL_HOME = 'C:\antigravity-bridge\.lark-channel'
    $env:LARK_CHANNEL_ANTIGRAVITY_BIN = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
    $env:PATH = "C:\antigravity-bridge\bin;$env:PATH"
    node (Join-Path $RepoRoot 'dist\cli.js') run `
      --profile antigravity `
      --agent antigravity `
      --workspace C:\antigravity-bridge\workspace
  }
  'chariot' {
    $harnessRoot = [Environment]::GetEnvironmentVariable('DEEPSEEK_HARNESS_ROOT', 'User')
    if (!$harnessRoot) {
      $harnessRoot = 'C:\Users\ZhenpingXing\Documents\Codex\2026-08-14\git-clone-https-github-com-deepseek\deepseek-harness'
    }
    $harnessEntry = Join-Path $harnessRoot 'apps\cli\lib\bin.js'
    if (!(Test-Path -LiteralPath $harnessEntry)) {
      throw "DeepSeek Harness entry not found: $harnessEntry"
    }
    $env:LARK_CHANNEL_HOME = 'C:\deepseek-bridge\.lark-channel'
    $env:LARK_CHANNEL_ANTIGRAVITY_BIN = (Get-Command node -ErrorAction Stop).Source
    $env:LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY = $harnessEntry
    $env:PATH = "C:\deepseek-bridge\bin;$env:PATH"
    node C:\collab-runtime\deepseek\dist\cli.js run `
      --profile deepseek `
      --agent antigravity `
      --workspace C:\deepseek-bridge\workspace
  }
  'fool' {
    $hermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
    $python = Join-Path $hermesHome 'hermes-agent\venv\Scripts\python.exe'
    $env:HERMES_HOME = $hermesHome
    $env:PYTHONPATH = if ($env:PYTHONPATH) {
      "C:\collab-runtime\hermes;$env:PYTHONPATH"
    } else {
      'C:\collab-runtime\hermes'
    }
    $env:FEISHU_ALLOW_BOTS = 'mentions'
    & $python -m hermes_cli.main gateway run
  }
}
