# Repair owns control processes, never registered Hub/Bot process trees.
function Stop-CollabRepairTree([int]$ProcessId) {
  $registered = Read-CollabPidTable
  if (@($registered.Values | ForEach-Object { [int]$_ }) -contains $ProcessId) { return }
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)) {
    Stop-CollabRepairTree -ProcessId $child.ProcessId
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Invoke-CollabRepairStep([string]$Name, [string]$ScriptPath, [string[]]$ScriptArguments = @(), [int]$TimeoutSeconds = 45) {
  $process = [Diagnostics.Process]::new()
  $process.StartInfo.FileName = 'powershell.exe'
  $argsList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $ScriptArguments
  $process.StartInfo.Arguments = ($argsList | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' '
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  try {
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-CollabRepairTree -ProcessId $process.Id
      throw "$Name timed out after ${TimeoutSeconds}s; registered components preserved"
    }
    $exitCode = $process.ExitCode
    # A descendant retaining a pipe must not turn log collection into a hang.
    if ($stdout.Wait(1000)) { Write-Output $stdout.Result }
    if ($stderr.Wait(1000) -and $stderr.Result) { Write-Warning "$Name wrote stderr; inspect component logs" }
    if ($exitCode -ne 0) { throw "$Name exited with code $exitCode" }
  } finally { $process.Dispose() }
}
