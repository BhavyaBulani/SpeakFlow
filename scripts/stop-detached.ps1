# Stops whatever process is listening on the app port (default 8787).
# Needed because the detached server is not a child of this shell.

param([int]$Port = 8787)

$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($null -eq $connections) {
  Write-Output "nothing listening on $Port"
  exit 0
}

foreach ($pid_ in ($connections.OwningProcess | Sort-Object -Unique)) {
  try {
    Stop-Process -Id $pid_ -Force -ErrorAction Stop
    Write-Output "stopped pid=$pid_"
  } catch {
    Write-Output "could not stop pid=$pid_ : $($_.Exception.Message)"
  }
}
