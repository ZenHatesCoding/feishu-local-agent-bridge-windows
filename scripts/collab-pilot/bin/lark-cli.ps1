if ([string]::IsNullOrWhiteSpace($env:LARK_COLLAB_REAL_LARK_CLI_JS)) {
  throw 'LARK_COLLAB_REAL_LARK_CLI_JS is required by the collaboration pilot.'
}

& node $env:LARK_COLLAB_REAL_LARK_CLI_JS @args
exit $LASTEXITCODE
