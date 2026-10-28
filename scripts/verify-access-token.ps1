# Verifies that APP_ACCESS_TOKEN actually gates the API.
# Bounded: starts the server as a child process, probes, then stops it, so the
# whole command terminates and is safe from a non-interactive shell.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# The token is read from the environment, or from .env (which is gitignored).
# Never hardcode it here: scripts/ is tracked, so a literal would publish the
# shared secret in the repository.
$token = $env:APP_ACCESS_TOKEN
if ([string]::IsNullOrWhiteSpace($token) -and (Test-Path '.env')) {
  $line = Get-Content '.env' | Where-Object { $_ -match '^\s*APP_ACCESS_TOKEN\s*=' } | Select-Object -First 1
  if ($line) { $token = ($line -replace '^\s*APP_ACCESS_TOKEN\s*=', '').Trim() }
}
if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Output 'No APP_ACCESS_TOKEN found in the environment or .env - nothing to verify.'
  exit 1
}
$base = 'http://127.0.0.1:8791'

if (-not (Test-Path 'dist/server/index.js')) {
  Write-Output 'MISSING dist/server/index.js - run: npm run build:server'
  exit 1
}

$env:PORT = '8791'
$env:APP_ACCESS_TOKEN = $token
$env:NODE_ENV = 'development'

Remove-Item '.auth-probe.log', '.auth-probe.err.log' -ErrorAction SilentlyContinue

$server = Start-Process -FilePath 'node' `
  -ArgumentList 'dist/server/index.js' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $root '.auth-probe.log') `
  -RedirectStandardError (Join-Path $root '.auth-probe.err.log') `
  -PassThru

function Stop-Srv {
  if (-not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
}

function Get-Status([string]$label, [string]$url, [string]$method, [string]$body, [string]$auth) {
  $headers = @{}
  if ($auth -ne '') { $headers['Authorization'] = $auth }
  try {
    $params = @{
      Uri = $url; Method = $method; TimeoutSec = 8
      UseBasicParsing = $true; Headers = $headers
    }
    if ($body -ne '') { $params['Body'] = $body; $params['ContentType'] = 'application/json' }
    $r = Invoke-WebRequest @params
    Write-Output ('{0,-34} -> {1}' -f $label, [int]$r.StatusCode)
  } catch {
    $code = 'ERR'
    if ($_.Exception.Response -ne $null) {
      $code = [int]$_.Exception.Response.StatusCode
    }
    Write-Output ('{0,-34} -> {1}' -f $label, $code)
  }
}

try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $null = Invoke-WebRequest "$base/api/health" -TimeoutSec 2 -UseBasicParsing
      $ready = $true
      break
    } catch {
      if ($server.HasExited) { break }
    }
  }

  if (-not $ready) {
    Write-Output 'SERVER FAILED TO START'
    if (Test-Path '.auth-probe.err.log') { Write-Output (Get-Content '.auth-probe.err.log' -Raw) }
    if (Test-Path '.auth-probe.log') { Write-Output (Get-Content '.auth-probe.log' -Raw) }
    Stop-Srv
    exit 1
  }

  $config = Invoke-RestMethod -Uri "$base/api/config" -TimeoutSec 5
  Write-Output ("config.authRequired            -> {0}" -f $config.authRequired)
  Write-Output ''

  Get-Status 'health, no token (public)'      "$base/api/health"   'GET'  ''     ''
  Get-Status 'config, no token (public)'      "$base/api/config"   'GET'  ''     ''
  Get-Status 'sessions POST, no token'        "$base/api/sessions" 'POST' '{}'   ''
  Get-Status 'sessions POST, wrong token'     "$base/api/sessions" 'POST' '{}'   'Bearer wrong-token'
  Get-Status 'sessions POST, correct token'   "$base/api/sessions" 'POST' '{}'   "Bearer $token"
}
finally {
  Stop-Srv
}
