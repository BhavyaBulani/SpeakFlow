# PROGRESS — where we left off

**Read this first.** It is the handoff file: what is built, what is *verified*,
what is blocked, and the single next action. Update it at the end of every
working session so the next session starts here instead of re-reading the repo.

- Last updated: **2026-10-26 (fifth session)**
- Spec: `master_prompt.txt` + `prompt_2.txt` (prompt_2 wins on conflicts, and the
  addendum inside master_prompt wins over earlier sections).
- Durable platform traps (Windows shell, browser verification, provider
  registration) live in **`COVEXCODE.md`**, not here. This file is *status*.

---

## 1. Current position in one paragraph

All the plumbing exists and is green: two-stage reply engine (provisional →
refined), local response-library fast path, stale-response protection, six
tones, eight intents, chunked + realtime + fully-local speech-to-text, browser
tab / system / microphone capture, the MV3 extension, privacy controls, and the
zero-cost budget guards. **`npm test` is green (211 tests, 11 files).** The
one thing never proven is the only thing that cannot be proven here: a real
human voice from a real call reaching the pipeline, which needs a credential,
a real meeting tab, and a person. Nothing is marked **Verified** in
`docs/PLATFORM_STATUS.md` for exactly that reason — that is deliberate.

## 2. The single next action

> Both local-path levers named last session are now **closed** — `whisper-server`
> (transport) and `tiny.en` vs `base.en` (model choice). See §6. The **blocker** is
> unchanged and re-confirmed: the ₹0 end-to-end run is only **half-runnable**
> because no local reply model is installed. See §2a.
>
> **Fourth session: `.env` now exists** (it did not before, so the app could only
> ever run in mock mode). It is configured for the local stack — `whisper-cpp` on
> `ggml-tiny.en.bin`, `AI_PROVIDER=local` on `qwen2.5:3b-instruct` — and
> `npm run check:config` now prints which half is genuinely live. Nothing in
> `src/` changed. Start the model and the refined half becomes real with no
> further edits.

### 2a. The actual blocker on a ₹0 end-to-end run

Checked on 2026-10-26: `where ollama` found nothing, nothing is listening on
`127.0.0.1:11434`, and `.local-models/` holds only Whisper models — **no `.gguf`**.

| Half of the pipeline | ₹0 status |
|---|---|
| Speech → transcript | **Works.** local `whisper-cpp`, measured on real audio |
| Provisional reply | **Works.** local response library, p95 0.082 ms, no model needed |
| Refined reply | **Needs a model.** Falls back to a labelled `safe_fallback` |

So the app runs at ₹0 today, but refined replies are generic until a model is
reachable. Three ways to close it, cheapest first:

| Option | Cost | Trade-off |
|---|---|---|
| `ollama pull qwen2.5:3b-instruct` (~2 GB) + `AI_PROVIDER=local` | ₹0, one download | Several seconds per reply on CPU; more safe-fallbacks (see `docs/LOCAL_MODEL.md`) |
| Free-tier hosted key (e.g. Groq) via `AI_PROVIDER=groq` | ₹0 within quota | Quota can end; account needed; audio/text leaves the device |
| Leave it | ₹0 | Refined replies stay `safe_fallback` — honest, but not the product |

**Do not** use `OPENAI_API_KEY` for this. It is paid, and only buys true WebRTC
interim partials.

**Re-confirmed 2026-10-26 (fourth session)** — still no `ollama`, nothing on
`127.0.0.1:11434`, no `.gguf` in `.local-models/`. The app's own tool now states
it: `npm run check:config` ends with

```
speech -> transcript   READY (fully local, no key, no quota)
transcript -> refined  SAFE FALLBACK ONLY (nothing on the local endpoint; start the model server)
```

So the table above is machine-checkable rather than an assertion in a doc.

---

## 3. Milestone ledger

| Milestone (`prompt_2.txt` §L) | State |
|---|---|
| 0 — inspect repo, preserve working code | **Done** |
| 1 — real browser-tab capture + streaming STT proof | **Partially done** — code path implemented and seam-tested; real call audio never captured (needs a person + key) |
| 2 — canonical transcript state, ordering, dedupe, bounded queues, reconnect | **Done** — `src/shared/transcript.ts`, `src/shared/audioFraming.ts`, unit tested |
| 3 — trigger policy, provisional → refined, stale protection | **Done** — `src/shared/replyPipeline.ts`, unit tested; asserted in real Chromium |
| 4 — focused UI | **Done** — provisional vs refined labelled, tones, intents, copy, rewrite controls |
| 5 — free-tier config, limits, cache, quota fallback | **Done** — `AI_DAILY_REQUEST_BUDGET`, circuit breaker, honest `safe_fallback` |
| 6 — privacy / security / a11y / long-session stability | **Done** — redacting logger, rate limits, CORS regression tests, 390 px layout check |
| 7 — deploy on free tiers | **Not deployed.** Config files exist (`render.yaml`, `vercel.json`); nothing claimed live |

## 4. What is verified — and with which command

Only things actually run are listed. Numbers come from the last green run,
**re-confirmed 2026-10-26** (tests, bundle scan, extension check).

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | 0 errors |
| Typecheck | `npm run typecheck` | 0 errors |
| Unit + API + UI | `npm test` | **211 tests / 11 files, all pass** |
| Production build | `npm run build` | PASS |
| No secret in bundle/extension | `npm run check:bundle` | PASS, 10 files scanned |
| Extension manifest + syntax | `npm run check:extension` | PASS, 4 scripts parsed |
| Reply fast path timing | `npm run bench` | p95 **0.082 ms** (local library) |
| **Full local ₹0 pipeline** | `npm run bench:local` | speech→transcript **2870 ms**, transcript→reply **2.020 ms** |
| **Local STT transports** | `npm run bench:stt` | `cli` p50 **3868 ms** vs resident `server` p50 **2921 ms** (1.32×) |
| **Local models: accuracy** | `npm run bench:models` | clean: both **10/10** exact; noisy 10 dB: `tiny` **1.5%** WER vs `base` **0.0%** |
| **Local models: speed** | `npm run bench:models` | `tiny.en` **1.7–4.1×** faster than `base.en` (ratio varies with machine load) |
| Real Chromium app E2E | `npm run test:e2e` | 21 checks PASS |
| Extension loads in real Chrome | `node scripts/e2e-extension.mjs` | 12 checks PASS |

> `npm run verify` as one chained command can exceed the 300 s tool limit on this
> machine under load and be killed **mid-vitest**, which looks exactly like a
> hanging test. It is memory pressure, not a test failure: run `npm test`,
> `npm run check:bundle`, `npm run check:extension` separately and they pass.
> See `COVEXCODE.md`.

**Never verified, and not claimed anywhere:** transcription or reply from a real
human voice on a real Meet/Zoom/Discord/Slack/Teams/WhatsApp call; headset
(especially Bluetooth) playback continuing uninterrupted during capture;
end-to-end `speech → suggestion` latency on a hosted key; any deployment.

## 5. Blocked / known gaps

| Gap | Why it is not done | Cheapest way forward |
|---|---|---|
| Any platform marked Verified | Needs a real call + a person to speak. **A paid key is not required** | Run one real Meet call on the ₹0 stack: `STT_PROVIDER=whisper-cpp` + `AI_PROVIDER=local` |
| End-to-end latency figures | Same | UI already shows `Speech → reply`, `Speech → text`, `Text → request`, `Request → reply` |
| Refined replies at ₹0 | No local LLM installed (no Ollama, no `.gguf`) | `ollama pull qwen2.5:3b-instruct` then `AI_PROVIDER=local` — see §2a |
| `aiConfigured: true` can mean **"selected"**, not "running" | `deriveConfig()` is synchronous and must not block on a socket, so a `local` provider reports configured whenever it is chosen | **Fixed:** `/api/health` now carries a `replyModel` probe (`src/server/services/replyLiveness.ts`, 7 tests) and the UI shows a notice when a local model is selected but not answering; `npm run check:config` still prints it from the CLI |
| WASAPI desktop companion | No `dotnet`/`csc` toolchain on this machine | Use the existing `system` capture mode (Chrome "Share system audio") instead, or install a toolchain |
| Local route misses the ~1 s target | Remaining cost is CPU inference; the per-chunk startup half is gone, and `tiny.en` cuts it further | Nothing cheap left. The real fix for the ~1 s target is a streaming recogniser, not a smaller model |
| No interim partials on the chunked/local routes | Those routes finalise per chunk by design | Only `openai-realtime` (WebRTC) yields true partials |
| Multi-user auth / RLS | Out of scope for the ₹0 single-workspace prototype | `APP_ACCESS_TOKEN` is one shared gate, documented as such |
| Mobile SIM/WhatsApp/iOS capture | OS-blocked; no authorised API | Stays **Unsupported**; do not work around it |

## 6. Session log (newest first)

### 2026-10-26 (fifth session)

Closed the honesty gap the fourth session recorded but deliberately did not fix,
and found a real client bug while verifying it.

- **New `src/server/services/replyLiveness.ts`** — answers "is the reply model
  *answering*?", which `aiConfigured` cannot. Probes the OpenAI-compatible
  `/models` list (Ollama and LM Studio both expose it); **any** HTTP answer counts
  as listening. 5 s TTL, concurrent polls coalesced, never throws, and
  `applicable: false` for hosted providers so `/health` never polls a third party.
- **Wired to `/api/health`, not `/api/config`** — config is synchronous and
  cacheable, a socket probe is neither. `Services` gained `replyLiveness`, with a
  `livenessFetch` override so `tests/api.test.ts` never touches the network.
- **UI** now separates the two failures: "not configured" only when no provider
  is selected, "the local model is not answering" otherwise.
- **Found and fixed a real bug** (`src/client/App.tsx`): the base-URL fallback
  used `?? '/api'`, but `.env` ships `VITE_API_BASE_URL=` **empty**, so the base
  became `''` and every request dropped the `/api` prefix — answered 404 by the
  SPA's static handler. The whole UI showed "Server unreachable" against a
  healthy server. Invisible until a `.env` existed (created last session).
- **`VocabularyPanel.enabled` is now `boolean | null`** — `null` = config not yet
  loaded, instead of asserting the feature is off before knowing anything.
- **Fixed the `tests/ui.test.tsx` mock** to key on `input.url` (it did
  `String(input)` → `"[object Request]"`, so every route missed and fell through
  to the 404) and added the missing `/api/vocabulary` route. The "Save phrase
  stays disabled" failure was a real defect, not the documented load flake.
- **Verified this session:** `tsc --noEmit` clean; `eslint` clean on every
  touched file; `vitest run` **211/211 across 11 files**; `npm run build` OK;
  `check:bundle` OK; `check:extension` OK; `npm run test:e2e` PASS. `npm run
  verify` was deliberately **not** run as one command — memory ceiling.
- **Next action, unchanged:** `ollama pull qwen2.5:3b-instruct` + `ollama serve`,
  then `npm run check:config`; the last line should flip to READY and
  `/api/health` should report `replyModel.reachable: true`.

### 2026-10-26 (fourth session)

Created the missing `.env`. The workspace had none, so the app could only ever run
in mock mode — which made every ₹0 discussion academic.

- **`.env` (gitignored) now configures the local stack**, not the defaults:
  `STT_PROVIDER=whisper-cpp` with `WHISPER_CPP_BIN`/`WHISPER_CPP_MODEL` pointing at
  binaries verified present on disk, `WHISPER_CPP_MODE=cli`, and `AI_PROVIDER=local`
  on `qwen2.5:3b-instruct`. `MOCK_AI=0` deliberately. Model is `tiny.en` per last
  session's measurement, with `base.en` noted in a comment as the noisy-audio
  alternative.
- **New `npm run check:config`** (`scripts/check-config.mjs`): prints the resolved
  config through the *same* `deriveConfig()`/`toPublicAppConfig()` the server
  uses, then probes the endpoints config cannot. The distinction it exists to
  draw: a doc saying "local works" and a config saying `aiConfigured: true` are
  statements about **intent**; this prints **state**.
- **Real measured output this session:** `sttConfigured yes`, whisper binary and
  `ggml-tiny.en.bin` **present**, `realtimeConfigured no`, reply endpoint
  **ECONNREFUSED** → speech half READY, reply half safe-fallback-only. Exactly the
  §2a table, now machine-checked.
- **Resolved a stale gap:** §5 claimed "there is no git repo". There is one — 3
  commits, clean tree, `da7bedd`. Row replaced.
- **Recorded rather than papered over a real honesty gap:** `isAiConfigured()`
  returns true whenever `AI_PROVIDER=local` is *selected*. This is the same class
  of bug as the one fixed last session, in reverse — and flipping it back would
  re-break the keyless case that `tests/localProvider.test.ts` deliberately
  covers. The correct fix is a real liveness probe on `/api/health`, not a config
  predicate. **Not changed this session.**
- **Verified this session:** `npm run check:config` (output above);
  `eslint scripts/check-config.mjs` clean; `vitest run` over
  `api` + `localProvider` + `localStt` + `stt` = **83/83 passed**, confirming a
  real `.env` does not leak into the suite (tests never read `process.env`).
  **Not re-run:** full `npm test`, build, browser E2E — no `src/` code changed.
- **Next action, now one step shorter:** `ollama pull qwen2.5:3b-instruct &&
  ollama serve`, then re-run `npm run check:config`; the last line should flip to
  READY. No `.env` edit needed.

### 2026-10-26 (third session)

Measured the accuracy cost of the smaller local model, as §2 proposed.

- **Downloaded `ggml-tiny.en.bin`** (78 MB, vs 148 MB for `base.en`).
- **Built a real accuracy harness**, because one TTS sentence proves nothing:
  - `scripts/test-corpus.json` — 10 ground-truth sentences shaped like actual
    call speech (deadlines, an API slip, a clarification, scope creep…).
  - `scripts/make-test-corpus.ps1` — synthesises them with Windows SAPI at
    16 kHz mono. Synthesised locally, nothing downloaded.
  - `scripts/bench-models.mjs` / `npm run bench:models` — runs each model through
    the shipped `WhisperCppSttClient` and computes a real **word error rate**
    (Levenshtein over words) plus latency, in a `clean` and a `noisy` condition.
- **Result — accuracy cost is small but real, and appears under noise:**
  | Condition | `tiny.en` | `base.en` |
  |---|---|---|
  | clean, exact | 10/10 | 10/10 |
  | noisy 10 dB, WER | **1.5%** (9/10) | **0.0%** (10/10) |
  The one tiny error: `backend` → **`back in`**. A fluent wrong word, which is
  the dangerous kind because it reads as a fact rather than as an error.
- **Result — speed:** `tiny.en` p50 1097–1616 ms vs `base.en` 2811–4477 ms,
  i.e. **1.7–4.1× faster**. Reported as a range deliberately: two runs disagreed
  and a third was **killed at 300 s** having completed no condition. That is the
  documented memory ceiling, not a benchmark bug.
- **Fixed two flaws in my own first measurement** (both would have made the
  published numbers wrong): `backend` vs `back-end` was being scored as an error
  (hyphens now stripped, not split into spaces), and the clean corpus could not
  discriminate the models at all — hence the noisy condition.
- **Recommendation:** `tiny.en` for the live path (latency is the binding
  constraint; accuracy is identical on clean speech and one word worse under
  noise). Keep `base.en` if accuracy on noisy audio matters more than waiting.
- **Verified this session:** `node_modules\.bin\eslint.cmd .` clean,
  `node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit` clean, `npm run build` OK,
  `npx vitest run tests/localStt.test.ts tests/replyPipeline.test.ts` green,
  `npm run bench:models` produced the numbers above from real audio.
  (Lint caught one real error first: an unused `isWhisperCppAvailable` import in
  `bench-models.mjs`. Fixed. Note `npx eslint`/`npx tsc` hung on this machine —
  call the `node_modules\.bin\*.cmd` binaries directly when it is loaded.)
- Docs updated: `docs/LOCAL_STT.md` (new "Choosing a model" section with the
  trade-off table), `docs/BENCHMARKS.md`, `README.md`, `package.json`.

### 2026-10-26 (second session)

Closed the `whisper-server` gap that §2 named as the next action.

- **New `src/server/services/whisperServer.ts`** — `WhisperServerSttClient` talks
  to an already-running `whisper-server.exe` over HTTP so the model stays
  resident. Endpoint (`POST /inference`, multipart, `{"text": ...}`) was probed
  from the real binary, not assumed; this build has **no**
  `/v1/audio/transcriptions` route. Error mapping: unreachable →
  `PROVIDER_NOT_CONFIGURED` naming the URL, 429 → `AI_RATE_LIMITED`, 5xx →
  `AI_UPSTREAM_ERROR`, empty audio → `VALIDATION_FAILED`.
- **`WHISPER_CPP_MODE` (`cli` | `server`), `WHISPER_CPP_SERVER_URL`,
  `WHISPER_CPP_SERVER_BIN`** added to `config.ts`; `isSttConfigured()` checks the
  right binary per mode. Default stays `cli`, so nothing changes for existing setups.
- **Fixed a real bug**: `providerStatus()` in `services/index.ts` computed
  `stt.configured` as `sttApiKey !== null` — the exact trap recorded in
  `COVEXCODE.md`. A fully working local setup therefore reported itself broken in
  `/api/health`. Now uses `isSttConfigured()`. Regression test added.
- **New `npm run bench:stt`** (`scripts/bench-stt-transport.mjs`) drives the real
  client classes against the real binaries on the real WAV. Result: identical
  transcript from both, `cli` p50 3868 ms → `server` p50 2921 ms. ~950 ms of that
  is per-chunk process startup + temp-file write.
- **Verified this session:** `npm run typecheck` clean, `npx eslint .` clean,
  `npm run build` OK, `tests/localStt.test.ts` green, `npm run bench:stt` green.
  `npm test` = **203/204**, the single failure being `ui.test.tsx`
  "mounts and shows the live workspace" exceeding its 5000 ms timeout while the
  suite ran at 43 s (it had been 15 s). **Re-ran that file alone: passes.** That
  is the documented memory-pressure flake, not a regression from this change.
- Docs updated: `docs/LOCAL_STT.md` (both transports, measured comparison, honest
  caveat that numbers move with load), `docs/BENCHMARKS.md`, `README.md`,
  `.env.example`.

### 2026-10-26
- Found the repo green from the previous session (`.verify13.log`: 190 tests,
  build, bundle scan, extension check all PASS).
- **Resumed the dropped thread:** the fully-local ₹0 Whisper route was
  implemented, benchmarked and written up in `docs/LOCAL_STT.md`, but the main
  `README.md` never mentioned it — the front door did not describe the only
  path with no quota at all.
- Documented the local route in `README.md` (status table, commands, env vars,
  limitations) and added the real measured numbers to `docs/BENCHMARKS.md`.
- Fixed stale `README.md` figures that contradict the code: test counts
  (45 / 78 → 190 across 10 files) and a leftover "Hindi explanation uses the
  configured reply model" line, which contradicted the spec ban on explaining
  the incoming speaker in Hindi (spec §10 / addendum H).
- Created this file.
- Re-verified after the doc edits only: `npm test` **190/190 across 10 files**,
  `npm run check:bundle` PASS, `npm run check:extension` PASS.
- **Not re-run this session:** `npm run build`, `npm run typecheck`, `npm run lint`,
  `npm run bench:local`, the browser E2Es. They were green on 2026-10-23 and no
  code was touched (markdown only), but they are not claimed here as fresh.
- Tool time/memory note: the chained `npm run verify` was killed at 300 s this
  session; the same steps run individually passed. Recorded in `COVEXCODE.md`.

### 2026-10-23 (previous session)
- Local STT via `whisper.cpp`: provider adapter, `bench:local`, real-audio
  measurement (2870 ms speech→transcript), `docs/LOCAL_STT.md`.
- `docs/BENCHMARKS.md`: reply-library microbenchmarks, two real routing bugs
  found and fixed by the benchmark.
- Last green `npm run verify`.
