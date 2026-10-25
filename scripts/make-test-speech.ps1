# Generates a short spoken-English WAV on this Windows machine, for testing the
# local speech-to-text path without downloading any audio and without sending
# anything to a cloud service.
#
# Uses System.Speech (SAPI), which ships with Windows. Output is 16 kHz mono
# 16-bit PCM: the format whisper.cpp and the SpeakFlow chunked route both want.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-test-speech.ps1

param(
  [string]$OutFile = ".local-models/test-speech.wav",
  [string]$Text = "Can you explain why the application is taking longer to load today"
)

Add-Type -AssemblyName System.Speech

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

# 16 kHz, 16-bit, mono. Choosing a non-default format keeps the file small and
# avoids a resample step in the recogniser.
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)

$synth.SetOutputToWaveFile((Resolve-Path -LiteralPath $dir).Path + "\" + (Split-Path -Leaf $OutFile), $format)
$synth.Speak($Text)
$synth.Dispose()

$info = Get-Item $OutFile
Write-Output ("WROTE {0} ({1} bytes, 16 kHz mono PCM)" -f $info.Name, $info.Length)
Write-Output ("SPOKEN: {0}" -f $Text)
