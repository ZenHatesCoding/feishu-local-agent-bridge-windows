$ErrorActionPreference = "Stop"

function Initialize-DeepSeekHarnessEnvironment {
  param([Parameter(Mandatory = $true)][string]$Root)

  $defaultHarnessRoot = Join-Path $Root "vendor\deepseek-harness"
  $HarnessRoot = if ($env:DEEPSEEK_HARNESS_ROOT) {
    $env:DEEPSEEK_HARNESS_ROOT
  } else {
    $defaultHarnessRoot
  }
  $HarnessEntry = Join-Path $HarnessRoot "apps\cli\lib\bin.js"

  if (!(Test-Path $HarnessEntry)) {
    throw "DeepSeek Harness was not found at $HarnessRoot. Run .\\scripts\\bootstrap-deepseek-bridge.ps1 first, or set DEEPSEEK_HARNESS_ROOT to an existing source checkout."
  }

  $env:LARK_CHANNEL_HOME = Join-Path $Root ".lark-channel"
  $env:LARK_CHANNEL_ANTIGRAVITY_BIN = (Get-Command node -ErrorAction Stop).Source
  $env:LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY = $HarnessEntry
  $env:LARK_CHANNEL_DISABLE_PROXY = "1"
  $env:PATH = "$(Join-Path $Root "bin");$env:PATH"
  Remove-Item Env:HERMES_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:HERMES_GIT_BASH_PATH -ErrorAction SilentlyContinue
}
