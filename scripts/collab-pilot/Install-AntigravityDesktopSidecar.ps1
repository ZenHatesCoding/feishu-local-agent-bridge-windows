param(
  [Parameter(Mandatory=$true)][string]$DesktopRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$ProjectId,
  [Parameter(Mandatory=$true)][string]$WorkspaceRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$SidecarId
)
$ErrorActionPreference = 'Stop'
$DesktopRoot = [IO.Path]::GetFullPath($DesktopRoot)
$WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
if (!(Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) { throw 'WorkspaceRoot must be an existing directory in the selected App project.' }
$customization = Join-Path $env:USERPROFILE '.gemini/config'
if (!(Test-Path -LiteralPath (Join-Path $customization ('projects/' + $ProjectId + '.json')))) { throw 'Select an existing Antigravity App project first.' }
$project = Get-Content -LiteralPath (Join-Path $customization ('projects/' + $ProjectId + '.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
$bound = $false
foreach ($resource in @($project.projectResources.resources)) {
  $uri = if ($resource.gitFolder) { [string]$resource.gitFolder.folderUri } elseif ($resource.folder) { [string]$resource.folder.folderUri } else { '' }
  if ($uri -notlike 'file:///*') { continue }
  $folder = [IO.Path]::GetFullPath([uri]::UnescapeDataString($uri.Substring(8))).TrimEnd('\','/')
  if ($WorkspaceRoot.Equals($folder, [StringComparison]::OrdinalIgnoreCase) -or $WorkspaceRoot.StartsWith($folder + '\', [StringComparison]::OrdinalIgnoreCase)) { $bound = $true }
}
if (!$bound) { throw 'WorkspaceRoot is not inside the selected App project.' }
$assets = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../adapters/antigravity-desktop'))
$target = Join-Path $DesktopRoot 'host'
New-Item -ItemType Directory -Path $target -Force | Out-Null
if ($DesktopRoot.TrimEnd('\') -eq [IO.Path]::GetPathRoot($DesktopRoot).TrimEnd('\') -or $WorkspaceRoot.StartsWith($DesktopRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $WorkspaceRoot.Equals($DesktopRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'DesktopRoot must be a dedicated runtime directory, not the workspace or drive root.' }
$workerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $DesktopRoot '/inheritance:r' '/grant:r' ('*' + $workerSid + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' *> $null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect the desktop runtime directory ACL.' }
Copy-Item -LiteralPath (Join-Path $assets 'core.cjs') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $assets 'sidecar.cjs') -Destination $target -Force
$nodePath = (Get-Command node -ErrorAction Stop).Source
$utf8 = [Text.UTF8Encoding]::new($false)
$backupDir = Join-Path $DesktopRoot ('backups/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$configPath = Join-Path $customization 'config.json'
$hooksPath = Join-Path $customization 'hooks.json'
foreach ($file in @($configPath,$hooksPath)) { if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination $backupDir } }
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
if (!$config.sidecars) { $config | Add-Member -NotePropertyName sidecars -NotePropertyValue ([pscustomobject]@{}) -Force }
$config.sidecars | Add-Member -NotePropertyName $SidecarId -NotePropertyValue ([pscustomobject]@{enabled=$true;projectId=$ProjectId}) -Force
$sidecarDir = Join-Path $customization ('sidecars/' + $SidecarId)
New-Item -ItemType Directory -Path $sidecarDir -Force | Out-Null
$sidecar = @{command=$nodePath;args=@((Join-Path $target 'sidecar.cjs'));env=@{LARK_ANTIGRAVITY_DESKTOP_ROOT=$DesktopRoot;LARK_ANTIGRAVITY_WORKSPACE_ROOT=$WorkspaceRoot};restart_policy='on-failure';display_name='Feishu Worker desktop bridge';description='Runs authorized Feishu tasks in this App project'}
[IO.File]::WriteAllText((Join-Path $sidecarDir 'sidecar.json'),($sidecar|ConvertTo-Json -Depth 10),$utf8)
$hooks = if (Test-Path -LiteralPath $hooksPath) { Get-Content -LiteralPath $hooksPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
$definition = [ordered]@{enabled=$true}
foreach ($event in @('SessionStart','PreInvocation','PostInvocation','PreToolUse','PostToolUse','Stop')) {
  $invocation = '& "' + $nodePath + '" "' + (Join-Path $target 'core.cjs') + '" hook "' + $DesktopRoot + '" ' + $event
  $command = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($invocation))
  $handler = @{type='command';command=$command;timeout=10}
  $definition[$event] = if ($event -in @('PreToolUse','PostToolUse')) { ,@(@{matcher='.*';hooks=@($handler)}) } else { ,@($handler) }
}
$hooks | Add-Member -NotePropertyName ('feishu-worker-' + $SidecarId) -NotePropertyValue $definition -Force
[IO.File]::WriteAllText($hooksPath,($hooks|ConvertTo-Json -Depth 80),$utf8)
[IO.File]::WriteAllText($configPath,($config|ConvertTo-Json -Depth 80),$utf8)
Write-Output 'App Sidecar and named hooks installed. Existing customizations preserved. Wait for desktop heartbeat before switching the bridge.'
