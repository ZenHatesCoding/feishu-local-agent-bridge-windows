# Identity-neutral lark-cli entry point: the caller owns HOME, USERPROFILE,
# LARK_CHANNEL_* and LARKSUITE_CLI_CONFIG_DIR. See lark-cli.mjs for resolution.
& node (Join-Path $PSScriptRoot 'lark-cli.mjs') @args
exit $LASTEXITCODE
