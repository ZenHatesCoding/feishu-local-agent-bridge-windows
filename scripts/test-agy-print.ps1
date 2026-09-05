$ErrorActionPreference = "Stop"

$Agy = Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"
& $Agy --print "请只输出 OK" --print-timeout 1m
