# Where I left off

Snapshot: 28 Oct 2026.

## The blocker is closed

Both halves of the ₹0 pipeline are now **real and verified**:

| Half | State |
|---|---|
| Transcription (whisper.cpp) | **Done** — `ggml-tiny.en.bin`, no key, no quota |
| Replies (Ollama) | **Done** — `qwen2.5:3b-instruct` (1.93 GB) installed and generating real text |

`npm run check:config` now ends with both lines READY, and `node scripts/probe-model.mjs`
returns actual model output rather than a fallback.

## Two real bugs fixed in the liveness probe (do not regress these)

1. An **empty model list counted as "ready"** — the server up with nothing pulled
   reported `reachable: true` while every reply silently came from `safe_fallback`.
   `tests/replyLiveness.test.ts` now pins the opposite.
2. The model-name matcher compared only the part before the colon, so a configured
   `qwen2.5:3b-instruct` was satisfied by `qwen2.5:7b-instruct`, which answers the
   app's request with a 404. Now compares base + tag.
3. The 2 s CLI timeout was too short for a **cold** Ollama (measured ~2 s for the
   first `/v1/models` answer). Raised to 5 s in `scripts/check-config.mjs` and 3 s
   in the probe. A cold start was reporting "stopped".

## Next action

`ollama serve` must be running for refined replies to stay real — otherwise they
degrade to a labelled `safe_fallback` (honest, but generic). Ollama on this machine
auto-starts as `ollama app.exe`; the bare server is
`C:\Users\bhavy\AppData\Local\Programs\Ollama\ollama.exe serve`.

Note: that path must be passed to `cmd` **unquoted** — quoting it here produced
`'\"...\"' is not recognized as an internal or external command`.

After that, the only thing left that cannot be proven on this machine is a real
human voice on a real call, which needs a person and a meeting tab — see
`docs/PLATFORM_STATUS.md`, which is deliberately all-unverified.
