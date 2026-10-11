@echo off
rem Identity-neutral lark-cli entry point: the caller owns HOME, USERPROFILE,
rem LARK_CHANNEL_* and LARKSUITE_CLI_CONFIG_DIR. See lark-cli.mjs for resolution.
node "%~dp0lark-cli.mjs" %*
exit /b %ERRORLEVEL%
