function Initialize-AntigravityProxyEnvironment {
  if ($env:HTTP_PROXY -or $env:HTTPS_PROXY -or $env:ALL_PROXY) {
    return
  }

  try {
    $settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
  } catch {
    return
  }

  if ([int]$settings.ProxyEnable -ne 1 -or [string]::IsNullOrWhiteSpace([string]$settings.ProxyServer)) {
    return
  }

  $proxyServer = [string]$settings.ProxyServer
  $targets = @{}
  if ($proxyServer.Contains('=')) {
    foreach ($entry in $proxyServer.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries)) {
      $parts = $entry.Split('=', 2)
      if ($parts.Count -eq 2) {
        $targets[$parts[0].Trim().ToLowerInvariant()] = $parts[1].Trim()
      }
    }
  } else {
    $targets['http'] = $proxyServer.Trim()
    $targets['https'] = $proxyServer.Trim()
  }

  $httpTarget = if ($targets['http']) { $targets['http'] } else { $targets['https'] }
  $httpsTarget = if ($targets['https']) { $targets['https'] } else { $targets['http'] }
  if (-not $httpTarget -and -not $httpsTarget) {
    return
  }

  if ($httpTarget -and $httpTarget -notmatch '^[a-z][a-z0-9+.-]*://') { $httpTarget = "http://$httpTarget" }
  if ($httpsTarget -and $httpsTarget -notmatch '^[a-z][a-z0-9+.-]*://') { $httpsTarget = "http://$httpsTarget" }

  if ($httpTarget) { $env:HTTP_PROXY = $httpTarget }
  if ($httpsTarget) { $env:HTTPS_PROXY = $httpsTarget }
  $env:ALL_PROXY = if ($httpsTarget) { $httpsTarget } else { $httpTarget }
  if (-not $env:NO_PROXY) { $env:NO_PROXY = '127.0.0.1,localhost' }
}
