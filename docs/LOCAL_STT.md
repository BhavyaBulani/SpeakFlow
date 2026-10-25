# Fully local speech-to-text (₹0, no account, no key)

SpeakFlow can transcribe with an **open-source model running on your own
machine**. Nothing is sent to a cloud service, there is no signup, no API key
and no quota.

This is verified working on this machine with real speech audio — see
"Measured results" below.

## What it uses

| Piece | What | Licence |
|---|---|---|
| Recogniser | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) — C++ port of OpenAI's Whisper | MIT |
| Model | `ggml-base.en.bin` (English, ~142 MB) | MIT |
| Test audio | Windows built-in SAPI TTS (`scripts/make-test-speech.ps1`) | part of Windows |

No Python, no `pip`, no CUDA. The prebuilt Windows CPU binary is self-contained.

## Setup

```bash
# 1. Binary (CPU build) and model
mkdir .local-models
curl -sL -o .local-models/whisper.zip https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip
tar -xf .local-models/whisper.zip -C .local-models
curl -sL -o .local-models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# 2. Point SpeakFlow at it
# .env
STT_PROVIDER=whisper-cpp
# optional overrides:
# WHISPER_CPP_BIN=.local-models/Release/whisper-cli.exe
# WHISPER_CPP_MODEL=.local-models/ggml-base.en.bin
```

Confirm it works:

```bash
npm run bench:local
```

## Choosing a model: `tiny.en` vs `base.en`

Shipped models differ mainly in speed and in how they cope with noise. Measured
with `npm run bench:models` on 10 synthetic sentences whose text is known, so the
accuracy cost is a real word error rate (WER), not an impression.

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-test-corpus.ps1
npm run bench:models
```

| Condition | `tiny.en` | `base.en` |
|---|---|---|
| Clean speech, exact transcripts | **10/10** | **10/10** |
| Noisy at 10 dB SNR, mean WER | **1.5%** (9/10 exact) | **0.0%** (10/10 exact) |

The one `tiny.en` error was `backend` → **`back in`** — a plausible-sounding
near-miss rather than gibberish, which is the failure mode to watch for, because
a wrong-but-fluent word reads as a real fact in the transcript.

### Speed

| Model | p50 per chunk (two runs) | Size |
|---|---|---|
| `ggml-tiny.en.bin` | **1097 ms** / 1616 ms | 78 MB |
| `ggml-base.en.bin` | **4477 ms** / 2811 ms | 148 MB |

`tiny.en` measured **1.7×–4.1× faster** than `base.en`. The ratio is a range on
purpose: this laptop runs near its memory ceiling (`COVEXCODE.md`) and repeated
runs disagree. A third run was killed after 300 s having completed no condition
at all, which is a fair illustration of how much the absolute numbers move.

### What to choose

| If you care about | Use |
|---|---|
| Live latency — the product's main constraint | **`tiny.en`** |
| Best accuracy on noisy audio | `base.en` |

`tiny.en` is the sensible default for the live path: it was perfect on clean
speech and lost exactly one word under noise, while saving roughly 1.7–3.7 s of
waiting on every chunk. Switch back with `WHISPER_CPP_MODEL`.

**Honest limits of this measurement.** Ten synthetic sentences is a small sample;
a one-word difference is not statistically meaningful, so read this as "tiny is
close, and slightly worse under noise" rather than "tiny is 1.5% worse". SAPI
synthesis is also cleaner than an accented headset call, so both models will look
worse on real audio — these numbers are a floor, not a prediction.

## Two transports: `cli` and `server`

`whisper-cli` reads a file, so one chunk becomes one child process and every
chunk pays process startup plus model load. `whisper-server` keeps the model in
memory and accepts the WAV over HTTP. Both are implemented; pick with
`WHISPER_CPP_MODE`.

| | `WHISPER_CPP_MODE=cli` (default) | `WHISPER_CPP_MODE=server` |
|---|---|---|
| Extra setup | none | start the server yourself |
| Per-chunk cost | process start + model load + inference | inference only |
| Temp file on disk | yes (deleted in `finally`) | no — audio is posted directly |
| Measured p50 | **3868 ms** | **2921 ms** |

To run server mode:

```bash
# terminal 1 — leave it running
.local-models/Release/whisper-server.exe \
  -m .local-models/ggml-base.en.bin --host 127.0.0.1 --port 8080

# .env
STT_PROVIDER=whisper-cpp
WHISPER_CPP_MODE=server
# WHISPER_CPP_SERVER_URL=http://127.0.0.1:8080   (this is the default)
```

SpeakFlow **never launches the server**. It is a long-running process, and a
process spawned by the app cannot outlive the request on this machine (see
`COVEXCODE.md`); silently starting a background daemon is also not something a
web app should do. If the server is not running, transcription fails with a
clear message naming the URL, rather than a confusing model error.

Endpoint verified against the real binary, not guessed
(`scripts/probe-whisper-server.mjs`):

```text
POST {base}/inference      multipart form-data, field `file` = WAV
 -> 200 {"text":" Can you explain why the application is taking longer to load today?\n"}
```

This build does **not** expose `/v1/audio/transcriptions` (it returns 404), so
that OpenAI-compatible route is not used.

## Measured results (this machine, real audio)

```
PASS  transcript (2870 ms): "Can you explain why the application is taking longer to load today?"
PASS  suggestion (2.020 ms): "Let me check that and come back to you."
PASS  provisional reply does not assert an unknown fact

  speech -> transcript : 2870 ms  (local Whisper, ggml-base.en.bin)
  transcript -> reply  : 2.020 ms  (local library)
  speech -> suggestion : 2872 ms
```

That transcript is **verbatim correct** against the sentence that was spoken.

### Transport comparison (`npm run bench:stt`)

Same audio, same model, both transports, 5 iterations each after a warm-up:

```text
cli    (process per chunk)  min 3705  p50 3868  p95 4057  max 4057 ms
server (resident model)     min 2819  p50 2921  p95 2985  max 2985 ms

p50 improvement: 1.32x (946 ms saved per chunk)
```

Both returned the identical transcript, so the faster path is not buying speed
with accuracy. The ~950 ms gap is exactly the per-chunk process startup (plus the
temp-file write) that server mode removes. What is left — about 2.9 s — is CPU
inference on `ggml-base.en.bin`, which server mode cannot reduce.

Honest caveat: these numbers move with machine load. An earlier run measured
2870 ms for the CLI path; this box runs near its 16 GB commit ceiling (see
`COVEXCODE.md`). Both figures are real measurements, not estimates.

### Be honest about that 2.8–3.9 s

`prompt_2.txt` §8 targets ~1 s from sufficient partial context to a suggestion.
The local route **does not meet it**, and the reply engine is not the reason —
2 ms of the total is reply generation. The remaining cost is CPU inference on
`base.en`, plus process startup in `cli` mode.

- **Process startup.** `whisper-cli` is one process per chunk (~100–300 ms).
- **Inference.** `base.en` on CPU with `-t 4` for 4.4 s of audio.

Two honest ways to close the gap, one of which is now implemented:

1. **Server mode — implemented.** `WHISPER_CPP_MODE=server` removes the per-chunk
   process startup: 3868 → 2921 ms p50. See the comparison above.
2. **Smaller model — not done.** `ggml-tiny.en.bin` is several times faster and
   noticeably less accurate. Change `WHISPER_CPP_MODEL`.

Do not describe this as "real-time streaming". It is **chunked**: text appears
when a chunk closes, roughly every 2.4 s of speech plus inference. There are no
interim partials, so the provisional reply cannot fire mid-sentence from
transcript text alone on this route.

## Why a local model is the honest ₹0 answer

| Route | Cost | Needs |
|---|---|---|
| `whisper-cpp` (this) | **₹0, unbounded** | ~1 GB disk |
| `openai-compatible` + free tier | ₹0 within quota | account + key |
| `openai-realtime` | paid | OpenAI key |

Only the local route has no quota to exhaust. That is why it is the default for
anyone who wants a guarantee rather than a free tier that can change.

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `STT_PROVIDER` | `openai-realtime` | Set to `whisper-cpp` for local |
| `WHISPER_CPP_MODE` | `cli` | `cli` (process per chunk) or `server` (resident model) |
| `WHISPER_CPP_BIN` | `.local-models/Release/whisper-cli.exe` | Recogniser executable |
| `WHISPER_CPP_MODEL` | `.local-models/ggml-base.en.bin` | ggml model |
| `WHISPER_CPP_SERVER_URL` | `http://127.0.0.1:8080` | Running server, read only in server mode |
| `WHISPER_CPP_SERVER_BIN` | `.local-models/Release/whisper-server.exe` | Used only to check the install is present |
| `AI_REQUEST_TIMEOUT_MS` | `20000` | Also bounds one chunk's recognition |

`isSttConfigured()` for this provider means **the required files exist on disk**
(`whisper-cli` in `cli` mode, `whisper-server` in `server` mode, plus the model).
A key is not needed and is ignored, so a broken local setup cannot look healthy
just because some `STT_API_KEY` happens to be set.

## Failure behaviour

- Binary or model missing → `/api/config` reports `sttConfigured: false`, and
  transcription requests return `503 PROVIDER_NOT_CONFIGURED` naming the exact
  missing paths.
- It **never** silently switches to a hosted provider when the local one is
  missing. Substituting a paid service is a decision for the operator.
- A chunk that fails returns an error and the session keeps running.
- Every chunk is written to a private temp directory and deleted in `finally`;
  no audio is retained.

## Verified vs not verified

**Verified** (`npm run bench:local`, real audio, real binary): recognition of a
spoken sentence, verbatim correctness, timeout handling, and the full
speech → transcript → suggestion path.

**Verified** (`npm run bench:stt`, real audio, both binaries): `cli` and `server`
transports return the identical transcript, and the measured per-chunk cost of
each.

**Not verified**: a live browser tab feeding chunks into this route while a
human talks. That needs a browser, a meeting tab and a person; the plumbing is
covered by `tests/stt.test.ts` and `tests/audioFraming.test.ts`, but the seam
between them and a real voice is untested.
