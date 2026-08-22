param([switch]$RestoreOriginals)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$StateDir = Join-Path $RepoRoot '.runtime'
$PidFile = Join-Path $StateDir 'pids.json'
$HermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
$HermesPython = Join-Path $HermesHome 'hermes-agent\venv\Scripts\python.exe'
$HermesHook = Join-Path $HermesHome 'hooks\feishu-collaboration-hub'

function Stop-ProcessTree([int]$ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) { Stop-ProcessTree -ProcessId $child.ProcessId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $PidFile) {
  $pids = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
  foreach ($name in 'fool', 'chariot', 'justice', 'world', 'hub') {
    if ($pids.$name) { Stop-ProcessTree -ProcessId ([int]$pids.$name) }
  }
}
& $HermesPython -c "import sys; from hermes_cli.main import main; sys.argv=['hermes','gateway','stop']; main()" 2>$null
Remove-Item -LiteralPath $HermesHook -Recurse -Force -ErrorAction SilentlyContinue

if ($RestoreOriginals) {
  & C:\codex-bridge\start-codex-bridge.ps1
  & C:\antigravity-bridge\scripts\start-antigravity-bridge-service.ps1
  & C:\deepseek-bridge\scripts\start-deepseek-bridge-service.ps1
  & $HermesPython -c "import sys; from hermes_cli.main import main; sys.argv=['hermes','gateway','start']; main()"
}
