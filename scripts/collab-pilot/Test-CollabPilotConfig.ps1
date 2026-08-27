param([string]$Config)

$ErrorActionPreference = 'Stop'
if ($Config) { $env:LARK_COLLAB_PILOT_CONFIG = [IO.Path]::GetFullPath($Config) }
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')
$pilot = Get-CollabPilotConfig
$errors = [Collections.Generic.List[string]]::new()
$agents = @(Get-CollabAgents)
if ($agents.Count -eq 0) { $errors.Add('No enabled agents are configured.') }
if ((Test-CollabRunsHub) -and !(Test-Path -LiteralPath (Join-Path $script:CollabRepoRoot 'dist\cli.js'))) { $errors.Add('dist\cli.js is missing; run pnpm build.') }
if ((Get-CollabRole) -eq 'worker' -and !$pilot.hub.publicUrl) { $errors.Add('Worker role requires hub.publicUrl.') }
$launchAgents = @(Get-CollabLocalAgents)
foreach ($agent in $launchAgents) {
  if (!$agent.id -or !$agent.displayName) { $errors.Add('Every enabled agent needs id and displayName.'); continue }
  if (!$agent.launch.filePath) { $errors.Add("$($agent.id): launch.filePath is required."); continue }
  $file = Expand-CollabValue $agent.launch.filePath
  if (!(Test-Path -LiteralPath $file) -and !(Get-Command $file -ErrorAction SilentlyContinue)) { $errors.Add("$($agent.id): launch executable not found: $file") }
  if ($agent.launch.workingDirectory) {
    $cwd = Expand-CollabValue $agent.launch.workingDirectory
    if (!(Test-Path -LiteralPath $cwd -PathType Container)) { $errors.Add("$($agent.id): working directory not found: $cwd") }
  }
  if ($agent.hermesHook.enabled -and !(Test-Path -LiteralPath (Expand-CollabValue $agent.hermesHook.home) -PathType Container)) {
    $errors.Add("$($agent.id): Hermes home not found.")
  }
}
if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }
Write-Output "Config OK: $script:CollabManifestFile"
Write-Output "Role: $(Get-CollabRole)"
Write-Output "Enabled agents: $(($agents.id) -join ', ')"
Write-Output "Hub: $(Get-CollabHubUrl)"
