# Helper: locate ollama.exe (not on PATH in this session) and pull the reply model.
# Defaults to qwen2.5:3b-instruct because .env sets AI_MODEL=qwen2.5:3b-instruct,
# which overrides the 7b default in src/server/config.ts. Pulling 7b here would
# download 4.7 GB that the app never asks for.
param([string]$Model = 'qwen2.5:3b-instruct')
$ErrorActionPreference = 'Continue'

$candidates = @()

# Prefer the path of an already-running Ollama server process.
$proc = Get-Process ollama -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
if ($proc) { $candidates += (Join-Path (Split-Path $proc.Path -Parent) 'ollama.exe') }

$candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe')
$candidates += (Join-Path $env:PROGRAMFILES 'Ollama\ollama.exe')
if (${env:PROGRAMFILES(X86)}) { $candidates += (Join-Path ${env:PROGRAMFILES(X86)} 'Ollama\ollama.exe') }

$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) {
  $cmd = Get-Command ollama -ErrorAction SilentlyContinue
  if ($cmd) { $exe = $cmd.Source }
}

if (-not $exe) {
  Write-Output 'ERROR: could not find ollama.exe anywhere'
  Write-Output 'Tried:'
  $candidates | ForEach-Object { Write-Output "  $_" }
  exit 1
}

Write-Output "using ollama: $exe"
Write-Output '--- pull starting ---'

Write-Output "pulling: $Model"
& $exe pull $Model 2>&1 | ForEach-Object { Write-Output $_ }
$code = $LASTEXITCODE

Write-Output "--- pull finished with exit code $code ---"
exit $code
