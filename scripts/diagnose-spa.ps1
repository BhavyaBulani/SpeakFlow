# Diagnoses why the SPA does not render: confirms the HTML references a bundle,
# that the bundle is served with a JavaScript MIME type, and prints a short
# fingerprint of the bundle so a stale/missing asset is obvious.

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$html = (Invoke-WebRequest -Uri 'http://localhost:8787/' -UseBasicParsing).Content
Write-Output "HTML length: $($html.Length)"

$scriptMatches = [regex]::Matches($html, 'src="([^"]+\.js)"')
Write-Output "script tags found: $($scriptMatches.Count)"
foreach ($m in $scriptMatches) { Write-Output "  src=$($m.Groups[1].Value)" }

$cssMatches = [regex]::Matches($html, 'href="([^"]+\.css)"')
foreach ($m in $cssMatches) { Write-Output "  css=$($m.Groups[1].Value)" }

foreach ($m in $scriptMatches) {
  $url = 'http://localhost:8787' + $m.Groups[1].Value
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing
    Write-Output "ASSET $url -> $($r.StatusCode), type=$($r.Headers['Content-Type']), bytes=$($r.RawContentLength)"
  } catch {
    Write-Output "ASSET $url -> FAILED: $($_.Exception.Message)"
  }
}

foreach ($m in $cssMatches) {
  $url = 'http://localhost:8787' + $m.Groups[1].Value
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing
    Write-Output "CSS $url -> $($r.StatusCode), type=$($r.Headers['Content-Type']), bytes=$($r.RawContentLength)"
  } catch {
    Write-Output "CSS $url -> FAILED: $($_.Exception.Message)"
  }
}

# Show the start of the bundle so a raw-JSON 404 or HTML error page is visible.
if ($scriptMatches.Count -gt 0) {
  $url = 'http://localhost:8787' + $scriptMatches[0].Groups[1].Value
  $body = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
  $head = if ($body.Length -gt 220) { $body.Substring(0, 220) } else { $body }
  Write-Output "BUNDLE HEAD: $head"
}
