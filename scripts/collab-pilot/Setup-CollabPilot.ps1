param([string]$Config, [switch]$SkipInstall, [switch]$SkipBuild, [switch]$Force)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$stateDir = Join-Path $repoRoot '.runtime'
$target = if ($Config) { [IO.Path]::GetFullPath($Config) } else { Join-Path $stateDir 'pilot.local.json' }
$example = Join-Path $repoRoot 'config\collaboration-pilot.example.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
if ((Test-Path -LiteralPath $target) -and !$Force) {
  Write-Output "Keeping existing config: $target"
} else {
  Copy-Item -LiteralPath $example -Destination $target -Force
  Write-Output "Created local config: $target"
}
Push-Location -LiteralPath $repoRoot
try {
  if (!$SkipInstall) { & pnpm.cmd install; if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed.' } }
  if (!$SkipBuild) { & pnpm.cmd build; if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed.' } }
} finally {
  Pop-Location
}
Write-Output 'Next: edit the local config, enable your agents, then run Test-CollabPilotConfig.ps1.'
