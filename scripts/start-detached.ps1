# Starts the built server as a process owned by the WMI provider host, NOT by
# this shell's process tree. That matters: a tool that waits on its child's
# process tree will otherwise kill a long-running server, so a normal
# Start-Process / `start /B` gets reaped. Win32_Process.Create detaches fully.
#
# Used only for local verification. Stop it with scripts/stop-detached.ps1.

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$inner = "cmd /c cd /d `"$root`" && set MOCK_AI=1 && set NODE_ENV=development && node dist\server\index.js > .server.log 2> .server.err.log"

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $inner }

if ($result.ReturnValue -ne 0) {
  Write-Output "FAILED to create process, ReturnValue=$($result.ReturnValue)"
  exit 1
}

Write-Output "detached pid=$($result.ProcessId)"
