# Bounded smoke test: start the built server, probe the real HTTP endpoints,
# then shut it down. The whole script terminates, so it is safe to run from a
# non-interactive shell (a persistent server would hang the caller forever).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:MOCK_AI = '1'
$env:NODE_ENV = 'development'
$env:PORT = '8787'

Remove-Item -Path '.server.log', '.server.err.log' -ErrorAction SilentlyContinue

$server = Start-Process -FilePath 'node' `
  -ArgumentList 'dist/server/index.js' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $root '.server.log') `
  -RedirectStandardError (Join-Path $root '.server.err.log') `
  -PassThru

function Stop-Server {
  if (-not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
}

$results = [System.Collections.Generic.List[string]]::new()

try {
  # Wait up to ~15s for the port to answer.
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $null = Invoke-WebRequest -Uri 'http://localhost:8787/api/health' -TimeoutSec 2 -UseBasicParsing
      $ready = $true
      break
    } catch {
      if ($server.HasExited) { break }
    }
  }

  if (-not $ready) {
    $results.Add('HEALTH: FAILED TO START')
    if (Test-Path '.server.err.log') {
      $results.Add('--- stderr ---')
      $results.Add((Get-Content '.server.err.log' -Raw))
    }
    if (Test-Path '.server.log') {
      $results.Add('--- stdout ---')
      $results.Add((Get-Content '.server.log' -Raw))
    }
    $results | ForEach-Object { Write-Output $_ }
    Stop-Server
    exit 1
  }

  $results.Add('HEALTH: 200 OK')

  $config = Invoke-RestMethod -Uri 'http://localhost:8787/api/config' -TimeoutSec 5
  $results.Add("CONFIG: aiConfigured=$($config.aiConfigured) mockAi=$($config.mockAi) realtimeConfigured=$($config.realtimeConfigured) authRequired=$($config.authRequired) model=$($config.replyModel)")

  # Real session lifecycle over HTTP.
  $session = Invoke-RestMethod -Uri 'http://localhost:8787/api/sessions' -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 5
  $results.Add("SESSION: created id=$($session.id) transcriptPersisted=$($session.transcriptPersisted)")

  # Genuine two-stage reply generation through the mock provider.
  $body = @{
    stage = 'provisional'
    version = 1
    utterance = 'Could you explain why the application is taking longer to'
    utteranceUnfinished = $true
  } | ConvertTo-Json
  $provisional = Invoke-RestMethod -Uri "http://localhost:8787/api/sessions/$($session.id)/reply" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 10
  $results.Add("REPLY[provisional]: stage=$($provisional.stage) engine=$($provisional.engine) notice=$($provisional.notice) reply='$($provisional.suggestedReply)'")

  $body2 = @{
    stage = 'refined'
    version = 2
    utterance = 'Could you explain why the application is taking longer to load today?'
  } | ConvertTo-Json
  $refined = Invoke-RestMethod -Uri "http://localhost:8787/api/sessions/$($session.id)/reply" -Method Post -Body $body2 -ContentType 'application/json' -TimeoutSec 10
  $results.Add("REPLY[refined]: stage=$($refined.stage) engine=$($refined.engine) confidence=$($refined.confidence) reply='$($refined.suggestedReply)'")

  # Translation path.
  $tr = @{ text = 'Maine issue fix kar diya hai, aap dobara check kar sakte hain.' } | ConvertTo-Json
  $translated = Invoke-RestMethod -Uri 'http://localhost:8787/api/translate' -Method Post -Body $tr -ContentType 'application/json' -TimeoutSec 10
  $results.Add("TRANSLATE: engine=$($translated.engine) english='$($translated.english)'")

  # The SPA must be served by the same origin in production build.
  $page = Invoke-WebRequest -Uri 'http://localhost:8787/' -TimeoutSec 5 -UseBasicParsing
  $hasRoot = $page.Content -match 'id="root"'
  $results.Add("SPA: status=$($page.StatusCode) hasRootDiv=$hasRoot")

  # Cleanup path.
  Invoke-WebRequest -Uri "http://localhost:8787/api/sessions/$($session.id)" -Method Delete -TimeoutSec 5 -UseBasicParsing | Out-Null
  $results.Add('SESSION: deleted (204)')
}
catch {
  $results.Add("ERROR: $($_.Exception.Message)")
  if (Test-Path '.server.err.log') {
    $results.Add('--- stderr ---')
    $results.Add((Get-Content '.server.err.log' -Raw))
  }
}
finally {
  Stop-Server
}

$results | ForEach-Object { Write-Output $_ }
