# Detached launcher for the built SpeakFlow server (local smoke testing).
#
# Why a script file: passing $env: assignments through `cmd /C powershell -Command`
# gets mangled by cmd's quote handling. A .ps1 is unambiguous.
#
# Start-Process gives the child its OWN redirected handles, so the calling shell
# returns immediately instead of waiting on a server that never exits.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Deterministic, clearly-labelled mock AI: no provider key needed for a smoke test.
$env:MOCK_AI = '1'
$env:NODE_ENV = 'development'

Remove-Item -Path '.server.log', '.server.err.log' -ErrorAction SilentlyContinue

$process = Start-Process -FilePath 'node' `
  -ArgumentList 'dist/server/index.js' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $root '.server.log') `
  -RedirectStandardError (Join-Path $root '.server.err.log') `
  -PassThru

Write-Output "started pid=$($process.Id)"
