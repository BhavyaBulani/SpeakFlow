# Packages the extension/ directory into a zip suitable for the Chrome Web Store
# or for sharing with a tester. Excludes nothing functional - this is a tiny
# extension, and hiding files would only make review harder.
#
# NOTE: this produces a shippable archive; it does NOT publish to the Store
# (that needs a developer account, a listing, a privacy policy and review).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$source = Join-Path $root 'extension'
$target = Join-Path $root 'speakflow-extension.zip'

if (-not (Test-Path $source)) {
  Write-Error "extension/ directory not found"
  exit 1
}

# Validate before packaging: never ship a broken manifest.
& node (Join-Path $PSScriptRoot 'check-extension.mjs')
if ($LASTEXITCODE -ne 0) {
  Write-Error 'Extension validation failed; not packaging.'
  exit 1
}

Remove-Item -Path $target -ErrorAction SilentlyContinue

# Zip the CONTENTS of extension/ so manifest.json sits at the archive root,
# which is what the Chrome Web Store expects.
Push-Location $source
try {
  Compress-Archive -Path (Join-Path $source '*') -DestinationPath $target -Force
} finally {
  Pop-Location
}

$size = [math]::Round((Get-Item $target).Length / 1KB, 1)
Write-Output "packaged: $target ($size KB)"
Write-Output 'Load it with chrome://extensions -> Load unpacked (as a directory), or upload the zip to the Chrome Web Store.'
