@echo off
if not defined LARK_COLLAB_REAL_LARK_CLI_JS (
  echo LARK_COLLAB_REAL_LARK_CLI_JS is required by the collaboration pilot. 1>&2
  exit /b 1
)
node "%LARK_COLLAB_REAL_LARK_CLI_JS%" %*
exit /b %ERRORLEVEL%
