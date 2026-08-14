[CmdletBinding()]
param(
  [switch]$SkipHarness
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$HarnessRoot = Join-Path $Root "vendor\deepseek-harness"

function Invoke-Pnpm {
  param([string]$WorkingDirectory, [string[]]$Arguments)
  Push-Location $WorkingDirectory
  try {
    & corepack pnpm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm failed in $WorkingDirectory" }
  } finally {
    Pop-Location
  }
}

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required. Install Node.js first."
}
if (!(Get-Command git -ErrorAction SilentlyContinue) -and !$SkipHarness) {
  throw "Git is required to download DeepSeek Harness. Install Git first or rerun with -SkipHarness and set DEEPSEEK_HARNESS_ROOT."
}
if (!(Get-Command corepack -ErrorAction SilentlyContinue)) {
  throw "Corepack is required. Install a current Node.js 22 release and run corepack enable."
}

Write-Output "Installing bridge dependencies..."
Invoke-Pnpm -WorkingDirectory $Root -Arguments @("install", "--frozen-lockfile")
Invoke-Pnpm -WorkingDirectory $Root -Arguments @("build")

if (!$SkipHarness) {
  if (!(Test-Path (Join-Path $HarnessRoot ".git"))) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HarnessRoot) | Out-Null
    Write-Output "Downloading DeepSeek Harness..."
    & git clone https://github.com/deepseek-ai/deepseek-harness.git $HarnessRoot
    if ($LASTEXITCODE -ne 0) { throw "Could not clone DeepSeek Harness." }
  }

  Write-Output "Installing DeepSeek Harness dependencies..."
  Invoke-Pnpm -WorkingDirectory $HarnessRoot -Arguments @("install", "--frozen-lockfile")
  Invoke-Pnpm -WorkingDirectory $HarnessRoot -Arguments @("build:lib")
}

$HarnessEntry = Join-Path $HarnessRoot "apps\cli\lib\bin.js"
if (!$SkipHarness -and !(Test-Path $HarnessEntry)) {
  throw "DeepSeek Harness built without its CLI entry at $HarnessEntry."
}

Write-Output "Bootstrap complete. Next run .\\scripts\\setup-deepseek-feishu.ps1 to bind a Feishu app."
