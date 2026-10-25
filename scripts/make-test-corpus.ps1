# Synthesises the ground-truth accuracy corpus with Windows SAPI (System.Speech).
#
# Why: comparing Whisper models on one sentence proves almost nothing. This
# produces a fixed set of sentences whose exact text is known, so the benchmark
# can compute a real word error rate instead of eyeballing a transcript.
#
# Everything is generated locally by the Windows speech synthesizer. No audio is
# downloaded and nothing leaves the machine.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-test-corpus.ps1

param(
  [string]$CorpusJson = "scripts/test-corpus.json",
  [string]$OutDir = ".local-models/corpus"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

if (-not (Test-Path $CorpusJson)) {
  Write-Error "missing corpus file: $CorpusJson"
}
if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$out = (Resolve-Path -LiteralPath $OutDir).Path
$corpus = Get-Content -LiteralPath $CorpusJson -Raw | ConvertFrom-Json

# 16 kHz, 16-bit, mono: what whisper.cpp and the chunked STT route both want.
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$count = 0

foreach ($sentence in $corpus.sentences) {
  $path = Join-Path $out ($sentence.id + ".wav")
  $synth.SetOutputToWaveFile($path, $format)
  $synth.Speak($sentence.text)
  $count++
  $info = Get-Item $path
  Write-Output ("WROTE {0} ({1} bytes)  {2}" -f $info.Name, $info.Length, $sentence.text)
}

$synth.Dispose()
Write-Output ("`nWROTE {0} sentences to {1}" -f $count, $out)
