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

$RegistryFile = Join-Path $env:LARK_CHANNEL_HOME "registry\processes.json"
if (Test-Path $RegistryFile) {
  $registry = Get-Content $RegistryFile -Raw | ConvertFrom-Json
  $running = @($registry.entries | Where-Object {
    $_.profileName -eq "deepseek" -and (Get-Process -Id $_.pid -ErrorAction SilentlyContinue)
  })
  if ($running.Count -gt 0) {
    Write-Output "DeepSeek bridge is already running (ID: $($running[0].id), PID: $($running[0].pid))."
    exit 0
  }
}

$Runner = Join-Path $PSScriptRoot "run-deepseek-bridge.ps1"
$process = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Runner
)
Write-Output "Started DeepSeek bridge host process (PID: $($process.Id))."
