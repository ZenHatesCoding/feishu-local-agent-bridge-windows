$env:HERMES_HOME = ""
$env:HERMES_GIT_BASH_PATH = ""
$env:HOME = "C:\antigravity-bridge"
$env:USERPROFILE = "C:\antigravity-bridge"
$env:LARK_CHANNEL = "1"
$env:LARK_CHANNEL_HOME = "C:\antigravity-bridge\.lark-channel"
$env:LARK_CHANNEL_PROFILE = "antigravity"
$env:LARK_CHANNEL_CONFIG = "C:\antigravity-bridge\.lark-channel\profiles\antigravity\lark-cli-source\config.json"
$env:LARKSUITE_CLI_CONFIG_DIR = "C:\antigravity-bridge\.lark-channel\profiles\antigravity\lark-cli"
& "C:\Users\ZhenpingXing\.trae-cn\binaries\node\versions\24.14.0\lark-cli.ps1" @args
exit $LASTEXITCODE
