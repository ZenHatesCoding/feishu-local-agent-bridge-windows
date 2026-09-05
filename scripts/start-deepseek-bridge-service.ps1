$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'deepseek-harness-env.ps1')
Initialize-DeepSeekHarnessEnvironment -Root $Root
$RegistryFile = Join-Path $env:LARK_CHANNEL_HOME 'registry\processes.json'
if (Test-Path -LiteralPath $RegistryFile) {
  $registry = Get-Content -LiteralPath $RegistryFile -Raw | ConvertFrom-Json
  $running = @($registry.entries | Where-Object { $_.profileName -eq 'deepseek' -and (Get-Process -Id $_.pid -ErrorAction SilentlyContinue) })
  if ($running.Count) { Write-Output "DeepSeek bridge is already running (PID: $($running[0].pid))."; exit 0 }
}
$Runner = Join-Path $PSScriptRoot 'run-deepseek-bridge.ps1'
$process = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Runner)
Write-Output "Started DeepSeek bridge host process (PID: $($process.Id))."
