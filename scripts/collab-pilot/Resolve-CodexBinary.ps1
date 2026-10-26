<#
.SYNOPSIS
  Keep the codex binary fresh across codex auto-updates by resolving the
  newest *complete* codex install directory and writing it back to both the
  requested lark-channel profile and the requested pilot agent environment.

.DESCRIPTION
  OpenAI Codex auto-updates install into a new hash-versioned directory under
  %LOCALAPPDATA%\OpenAI\Codex\bin and gut the previous one (leaving only
  codex.exe and removing codex-code-mode-host.exe). The bridge runs shell
  commands through codex-code-mode-host.exe, which MUST sit next to codex.exe
  in the same version directory. When the pinned binaryPath points at a gutted
  directory, world fails with "os error 2: 系统找不到指定的文件" on every
  shell tool call -- so codex looks broken even though it is installed.

  This script scans the codex bin root for the newest directory that contains
  BOTH codex.exe and codex-code-mode-host.exe (a complete install) and writes
  that codex.exe path back into:

    1. the lark-channel codex profile config  -> profiles.<ProfileName>.codex.binaryPath
    2. the pilot manifest <AgentId> agent env -> launch.environment.<EnvName>

  whenever the currently-pinned path differs. Writes are atomic and preserve
  each file's native line endings and formatting -- only the targeted value
  changes, so diffs stay minimal.

  Intended to run at every world launch (hooked from run-agent.ps1) so a codex
  auto-update can never leave world pointing at a gutted directory. Idempotent:
  a no-op when the pinned path already matches the newest complete install.
  Opt out entirely with LARK_CHANNEL_CODEX_BIN_DISABLE_RESOLVE=1.

.PARAMETER SearchRoot
  Directory holding hash-versioned codex install subdirectories. Defaults to
  %LOCALAPPDATA%\OpenAI\Codex\bin.

.PARAMETER ConfigJson
  lark-channel profile config (profiles.<ProfileName>.codex.binaryPath).
  Defaults to %USERPROFILE%\.lark-channel\config.json.

.PARAMETER PilotConfig
  Pilot manifest with agents[].launch.environment.<EnvName>. Defaults to the
  pilot manifest resolved by Pilot.Common.ps1 ($script:CollabManifestFile).

.PARAMETER AgentId
  Required: agent whose <EnvName> env should be updated in the pilot manifest.

.PARAMETER EnvName
  Environment variable name in the pilot agent launch block. Default:
  LARK_CHANNEL_CODEX_BIN.

.PARAMETER ProfileName
  Explicit lark-channel profile name whose codex.binaryPath is updated.
  Use SkipProfileWrite when the launch does not select a known profile.

.PARAMETER DryRun
  Resolve and report what would change, but do not write anything.

.PARAMETER Quiet
  Suppress informational host output. The resolved path is still written to the
  success stream so callers can capture it.

.OUTPUTS
  The resolved codex.exe path (string) on the success stream. Empty when no
  complete codex install was found. Diagnostics go to the host stream.
#>
param(
  [string]$SearchRoot = (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'),
  [string]$ConfigJson = (Join-Path $env:USERPROFILE '.lark-channel\config.json'),
  [string]$PilotConfig,
  [Parameter(Mandatory = $true)][string]$AgentId,
  [string]$EnvName = 'LARK_CHANNEL_CODEX_BIN',
  [string]$ProfileName,
  [switch]$SkipProfileWrite,
  [switch]$DryRun,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# Pilot.Common.ps1 gives us $script:CollabManifestFile (and honors the
# LARK_COLLAB_PILOT_CONFIG override). Self-contained: dot-source it ourselves
# so the script also works when invoked standalone, not only from run-agent.
. (Join-Path $PSScriptRoot 'Pilot.Common.ps1')
if (-not $PilotConfig) { $PilotConfig = $script:CollabManifestFile }

function Write-ResolveNote {
  param([string]$Message)
  if (-not $Quiet) { Write-Host "[resolve-codex-binary] $Message" }
}

function Find-NewestCompleteCodex {
  param([string]$Root)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $null }
  $complete = Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $codexExe = Join-Path $_.FullName 'codex.exe'
    $hostExe = Join-Path $_.FullName 'codex-code-mode-host.exe'
    if ((Test-Path -LiteralPath $codexExe) -and (Test-Path -LiteralPath $hostExe)) {
      [PSCustomObject]@{ Dir = $_.FullName; CodexExe = $codexExe; Mtime = (Get-Item -LiteralPath $codexExe).LastWriteTimeUtc }
    }
  }
  if (-not $complete) { return $null }
  return ($complete | Sort-Object Mtime -Descending | Select-Object -First 1).CodexExe
}

function Get-PinnedConfigPath {
  param([string]$File, [string]$Profile)
  if (-not (Test-Path -LiteralPath $File)) { return $null }
  try {
    $j = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    if ($j.profiles.$Profile.codex.binaryPath) { return [string]$j.profiles.$Profile.codex.binaryPath }
  } catch { Write-ResolveNote "could not read $File : $($_.Exception.Message)" }
  return $null
}

function Get-PinnedPilotPath {
  param([string]$File, [string]$Agent, [string]$Env)
  if (-not (Test-Path -LiteralPath $File)) { return $null }
  try {
    $j = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    $a = $j.agents | Where-Object { $_.id -eq $Agent } | Select-Object -First 1
    if ($a -and $a.launch -and $a.launch.environment -and $a.launch.environment.$Env) {
      return [string]$a.launch.environment.$Env
    }
  } catch { Write-ResolveNote "could not read $File : $($_.Exception.Message)" }
  return $null
}

# Format-preserving JSON field setter. node's JSON.stringify(_, null, 2) matches
# the native 2-space style of both files; we additionally detect and preserve
# each file's line endings (CRLF/LF) and trailing-newline presence so the diff
# is exactly the changed value. Writes go through a temp file + rename so a
# concurrent reader never sees a partial file.
$script:NodeCodexEdit = @'
const fs = require('fs');
const file = process.argv[1];
const op = process.argv[2];
if (!file || !op) { process.stderr.write('usage: file op ...\n'); process.exit(2); }
let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch (e) { process.stderr.write('cannot read ' + file + ': ' + e.message + '\n'); process.exit(2); }
const crlf = raw.indexOf('\r\n') >= 0;
const eol = crlf ? '\r\n' : '\n';
const hasTrailing = /\r?\n$/.test(raw);
let j;
try { j = JSON.parse(raw); }
catch (e) { process.stderr.write('cannot parse ' + file + ': ' + e.message + '\n'); process.exit(2); }
if (op === 'config-profile') {
  const profile = process.argv[3];
  const val = process.argv[4];
  if (!profile || !val) { process.stderr.write('config-profile needs profile val\n'); process.exit(2); }
  if (!j.profiles?.[profile]?.codex) { process.stderr.write('existing Codex profile required\n'); process.exit(2); }
  j.profiles[profile].codex.binaryPath = val;
} else if (op === 'pilot-agent-env') {
  const agentId = process.argv[3];
  const envName = process.argv[4];
  const val = process.argv[5];
  if (!agentId || !envName || !val) { process.stderr.write('pilot-agent-env needs agentId envName val\n'); process.exit(2); }
  if (!Array.isArray(j.agents)) { process.stderr.write('agents is not an array in ' + file + '\n'); process.exit(3); }
  const a = j.agents.find(function (x) { return x && x.id === agentId; });
  if (!a) { process.stderr.write('agent ' + agentId + ' not found in ' + file + '\n'); process.exit(4); }
  if (!a.launch) a.launch = {};
  if (!a.launch.environment) a.launch.environment = {};
  a.launch.environment[envName] = val;
} else {
  process.stderr.write('unknown op: ' + op + '\n');
  process.exit(5);
}
let body = JSON.stringify(j, null, 2).split('\n').join(eol);
if (hasTrailing) body += eol;
const tmp = file + '.resolve-tmp-' + process.pid;
try {
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (e2) {}
  process.stderr.write('failed to write ' + file + ': ' + e.message + '\n');
  process.exit(6);
}
'@

function Set-CodexField {
  param(
    [string]$File,
    [string]$Op,
    [string[]]$OpArgs
  )
  $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
  $allArgs = @($File, $Op) + $OpArgs
  & $nodeExe -e $script:NodeCodexEdit @allArgs
  if ($LASTEXITCODE -ne 0) {
    throw "node JSON edit failed for $File (op=$Op, exit $LASTEXITCODE)"
  }
}

function Backup-FileTimestamped {
  param([string]$File)
  if (-not (Test-Path -LiteralPath $File)) { return }
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
  $bak = "$File.bak-codex-resolve-$stamp"
  if (-not (Test-Path -LiteralPath $bak)) { Copy-Item -LiteralPath $File -Destination $bak -Force }
  Write-ResolveNote "backed up $File -> $bak"
}

try {
  if (!$SkipProfileWrite -and !$ProfileName) { throw 'ProfileName is required unless SkipProfileWrite is set' }
  $configured = Get-PinnedPilotPath -File $PilotConfig -Agent $AgentId -Env $EnvName
  # Explicit installations outside the App-managed tree are intentional pins.
  $managedRoot = [IO.Path]::GetFullPath($SearchRoot).TrimEnd('\') + '\'
  if ($configured -and !([IO.Path]::GetFullPath($configured).StartsWith($managedRoot, [StringComparison]::OrdinalIgnoreCase))) {
    Write-ResolveNote 'explicit Codex installation retained'
    Write-Output $configured
    exit 0
  }
  $resolved = Find-NewestCompleteCodex -Root $SearchRoot
  if (-not $resolved) {
    Write-ResolveNote "no complete codex install (codex.exe + codex-code-mode-host.exe) under $SearchRoot; leaving configs unchanged."
    Write-Output ''
    exit 0
  }

  $pinnedConfig = Get-PinnedConfigPath -File $ConfigJson -Profile $ProfileName
  $pinnedPilot = Get-PinnedPilotPath -File $PilotConfig -Agent $AgentId -Env $EnvName

  $configStale = !$SkipProfileWrite -and ((-not $pinnedConfig) -or ($pinnedConfig -ne $resolved))
  $pilotStale = (-not $pinnedPilot) -or ($pinnedPilot -ne $resolved)

  if (-not $configStale -and -not $pilotStale) {
    Write-ResolveNote "codex binary already resolved and up to date: $resolved"
    Write-Output $resolved
    exit 0
  }

  Write-ResolveNote "newest complete codex install resolved: $resolved"
  if ($pinnedConfig) { Write-ResolveNote "config.json binaryPath: $pinnedConfig" } else { Write-ResolveNote "config.json binaryPath: (unset)" }
  if ($pinnedPilot) { Write-ResolveNote "pilot $AgentId env ${EnvName}: $pinnedPilot" } else { Write-ResolveNote "pilot $AgentId env ${EnvName}: (unset)" }

  if ($DryRun) {
    Write-ResolveNote "dry-run: no files written."
    Write-Output $resolved
    exit 0
  }

  if ($configStale) {
    Backup-FileTimestamped -File $ConfigJson
    Set-CodexField -File $ConfigJson -Op 'config-profile' -OpArgs @($ProfileName, $resolved)
    Write-ResolveNote "updated $ConfigJson ($ProfileName.codex.binaryPath -> $resolved)"
  }
  if ($pilotStale) {
    Backup-FileTimestamped -File $PilotConfig
    Set-CodexField -File $PilotConfig -Op 'pilot-agent-env' -OpArgs @($AgentId, $EnvName, $resolved)
    Write-ResolveNote "updated $PilotConfig ($AgentId.launch.environment.$EnvName -> $resolved)"
  }

  Write-Output $resolved
} catch {
  # Best-effort: never break the caller's launch. Report and emit empty so the
  # caller keeps whatever binaryPath was already configured.
  Write-ResolveNote "ERROR: $($_.Exception.Message)"
  Write-Output ''
}
