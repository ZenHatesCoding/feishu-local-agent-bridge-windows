$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$env:LARK_CHANNEL_HOME = Join-Path $Root '.lark-channel-deepseek'
$RegistryFile = Join-Path $env:LARK_CHANNEL_HOME 'registry\processes.json'
if (!(Test-Path -LiteralPath $RegistryFile)) { Write-Output 'DeepSeek bridge is not running.'; exit 0 }
$registry = Get-Content -LiteralPath $RegistryFile -Raw | ConvertFrom-Json
$entries = @($registry.entries | Where-Object { $_.profileName -eq 'deepseek' })
if (!$entries.Count) { Write-Output 'DeepSeek bridge is not running.'; exit 0 }
foreach ($entry in $entries) { node (Join-Path $Root 'dist\cli.js') kill $entry.id }
