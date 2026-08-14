$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20.12 or newer is required. Install Node.js first."
}
if (!(Get-Command corepack -ErrorAction SilentlyContinue)) {
  throw "Corepack is required. Install a current Node.js release and run corepack enable."
}
if (!(Test-Path (Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"))) {
  throw "Antigravity CLI was not found at $env:LOCALAPPDATA\\agy\\bin\\agy.exe. Install and sign in to Antigravity first."
}

Push-Location $Root
try {
  & corepack pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "Bridge dependency installation failed." }
  & corepack pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Bridge build failed." }
} finally {
  Pop-Location
}

Write-Output "Bootstrap complete. Run .\\scripts\\run-antigravity-bridge.ps1 and scan the Feishu QR code to create or bind the bot."
