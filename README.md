# SpeakFlow AI

A live-call copilot for professionals who understand the work but lose fluency in fast English
client calls. It listens to the client, and **gives you an English sentence you can say out loud
while they are still talking**, then replaces it with a better one when their thought is finished.

Built for the real failure mode of a live call: not "I need a transcript", but "someone just
asked me something and I am silent for four seconds".

```
Client (partial):  "Could you explain why the application is taking longer to…"
PRELIMINARY:       "Let me check what's causing the delay."
Client finishes:   "…load today?"
READY TO SAY:      "I'll investigate what's causing the loading delay and update you once
                    I have more information."
```

---

## 1. What is actually implemented

| Area | Status |
|---|---|
| Two-stage reply engine (provisional → refined) | Implemented, with an explicit decision policy |
| **Local response library fast path** (₹0, no provider call) | Implemented — 15 records, p95 **0.082 ms** measured (`npm run bench`) |
| Max-wait safeguard so a non-stop speaker still gets a suggestion | Implemented + unit tested |
| Labels required by prompt 2: `Live suggestion · still listening` / `Suggested reply` | Implemented, asserted in the browser E2E |
| Named live pipeline stage (listening/transcribing/preparing/refining/unavailable) | Implemented — `data-testid="pipeline-stage"`, asserted in the browser E2E |
| Audio-loss disclosure (known gaps marked uncertain, never smoothed over) | Implemented — `context-uncertain` event from the chunked provider, sticky banner |
| Six reply tones (professional/friendly/concise/confident/diplomatic/empathetic) | Implemented — distinct prompt rule each, asserted by test |
| Eight response intents (answer/clarify/ask-for-time/…) | Implemented — overrides stage guidance where they conflict |
| Rewrite controls (simpler/shorter/natural/formal) | Implemented — rewrites the existing script, never re-answers the transcript |
| Latin-script check + provisional/refined versioning, stale-reply rejection | Implemented, unit tested |
| Request cancellation of superseded AI calls | Implemented (AbortController end-to-end) |
| Live streaming transcription over WebRTC (OpenAI Realtime) | Implemented against the verified API |
| **Chrome extension (MV3) for tab audio** | Implemented — `chrome.tabCapture` + offscreen + WebRTC relay |
| **Platform feasibility report (Android/iOS)** | Written — SIM and WhatsApp calls are BLOCKED/UNSUPPORTED |
| Browser-speech fallback (microphone) | Implemented |
| Demo transcript provider (clearly labelled simulation) | Implemented |
| Tab-audio capture + **silent-stream detection** before "Listening" | Implemented |
| Hindi explanation of client intent (Devanagari) | **Not implemented, by design** — spec §10 forbids a Hindi meaning/explanation of the incoming speaker's English |
| Hindi/Hinglish → spoken English translator (user-authored thought) | Implemented |
| Chunked (₹0-capable) speech-to-text route | Implemented + unit tested against a mocked provider — `docs/STT_PROVIDERS.md` |
| **Fully local speech-to-text (whisper.cpp)** — ₹0, no key, no quota, no audio leaving the machine | Implemented + measured on real audio (2870 ms speech→text) — `docs/LOCAL_STT.md` |
| Local open-weight reply model (Qwen/Llama via Ollama) | Implemented, opt-in — `docs/LOCAL_MODEL.md` |
| Windows desktop-app audio (Zoom/Teams/Discord) | **Implemented as capture mode `system`** (Chrome "Share system audio"), *not yet tested live* |
| Windows WASAPI loopback companion | **Not built** — no `dotnet`/`csc` on this machine; adapter path documented in `docs/PLATFORM_STATUS.md` |
| Per-platform capture status | `docs/PLATFORM_STATUS.md` — nothing is marked Verified, deliberately |
| Measured latency | `npm run bench` (reply engine) and `npm run bench:local` (full ₹0 pipeline) → `docs/BENCHMARKS.md` |
| Latency instrumentation (speech→text→request→reply) | Implemented, shown in the UI |
| Safe-reply contract, facts-to-verify, fallbacks | Implemented + prompt tested |
| Rate limiting, CORS allowlist, security headers, Zod validation | Implemented |
| Optional workspace access token | Implemented |
| Optional saved phrases (vocabulary) | Implemented — API, store **and UI panel** |
| **Permission onboarding (explain before prompt, real states)** | Implemented — `src/client/lib/permissions.ts` |
| No secret in browser bundle | Implemented + `npm run check:bundle` |
| Automated tests | **204 tests across 10 files** — `npm test` |
| Multi-user accounts / Supabase RLS | **Not implemented** — see Limitations |

Nothing in the UI is a mock button. When the provider is unconfigured the API says so and the UI
degrades to *Browser speech* / *Demo transcript* rather than pretending.

---

## 2. Quick start

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# put OPENAI_API_KEY=sk-... in .env  (optional - see below)
npm run dev               # API on :8787, UI on http://localhost:5173
```

Without a key the app still starts and the UI works, but replies/translation return a labelled
"provider not configured" state. To explore the full pipeline with no credentials:

```bash
# .env
MOCK_AI=1
```

then in Settings pick **Demo transcript**. Replies will be clearly badged `MOCK AI`.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | API (`tsx watch`) + Vite dev server concurrently |
| `npm run build` | Bundles server → `dist/server`, SPA → `dist/client` |
| `npm start` | Runs the built server (also serves the SPA) |
| `npm run typecheck` | `tsc --noEmit` over client, server, shared, tests |
| `npm test` | Vitest (pipeline + API + UI, 204 tests) |
| `npm run test:e2e` | Builds, then drives the real app in Chromium (21 checks) |
| `npm run bench` | Reply-engine microbenchmark; exits non-zero on regression |
| `npm run bench:local` | Full local ₹0 pipeline on real speech audio (needs `docs/LOCAL_STT.md` setup) |
| `npm run bench:stt` | Local STT transports compared on real audio (`cli` vs resident `server`) |
| `npm run bench:models` | Local models compared on real audio: speed **and** word error rate |
| `npm run check:bundle` | Fails if a provider secret reached the client bundle |
| `npm run check:extension` | Validates the MV3 manifest and parses every extension script |
| `npm run verify` | lint → typecheck → test → build → bundle scan → extension check |
| `npm run verify:full` | `verify` plus the real-browser E2E run |

---

## 3. Architecture

```
src/
  shared/            used by BOTH browser and server (no Node APIs)
    types.ts           domain types
    schemas.ts         Zod input validation + hand-written JSON Schema for Structured Outputs
    transcript.ts      pure transcript utilities (material-change, unfinished-sentence …)
    replyPipeline.ts   THE decision policy: when to spend an AI request, version gating
    errors.ts          error codes + browser capture error guidance
  server/
    app.ts             Express factory (no listen, no env reads) → testable in-process
    index.ts           startup, shutdown, session sweeper
    config.ts          single place env is read; deriveConfig() is pure
    lib/               logger (redacting), http (ApiError/async), auth, rateLimit
    routes/            health, sessions, translate, vocabulary, realtime
    services/
      openai.ts        OpenAI client: chat+Structured Outputs, realtime client_secret
      prompts.ts       the response contract (safety rules, worked example)
      replyEngine.ts   provisional/refined generation + validation + safe fallback
      translation.ts   Hindi/Hinglish → English
      breaker.ts       consecutive-failure circuit breaker
      sessions.ts      in-memory metadata only
      vocabulary.ts    opt-in file persistence
  client/
    App.tsx            workspace UI
    audio/             audioSource (capture + silence check), realtimeProvider,
                       browserSpeechProvider, simulatedProvider
    hooks/useCopilotSession.ts   provider lifecycle + pipeline wiring + latency
    components/        SettingsDrawer, TranslatorPanel
    lib/               api (validating fetch client), settings (localStorage)
tests/                 replyPipeline.test.ts, api.test.ts
```

### Why the decision policy is a separate pure module

Every provisional reply costs money and can distract the user mid-sentence. So *when* to fire is
not scattered through the React tree — it is `decideProvisional()` / `decideRefined()` in
`src/shared/replyPipeline.ts`, with rules that are unit tested:

- minimum 4 words of real context (filler like "uh, okay" never triggers a request)
- 1100 ms minimum interval between provisional requests
- at most 5 provisional requests per utterance
- a request is only re-fired when the text *materially* changed: rephrase (Jaccard distance
  > 0.34), 4+ new words, or a question appearing for the first time
- an in-flight request younger than 900 ms is allowed to finish instead of thrashing

Refined replies are debounced 220 ms and skipped for a duplicate utterance.

### How staleness is prevented

Every request carries a monotonic `version` from a sequencer. A response is only rendered if its
version is still the newest (`pickReplyForDisplay`); otherwise it is counted and dropped, and the
UI shows "N older reply dropped". Superseded in-flight requests are `abort()`ed, which the server
propagates to the provider via `res.on('close')` → `AbortController`, so cancelled work stops
being billed.

---

## 4. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | API port |
| `NODE_ENV` | `development` | `production` tightens logging |
| `CORS_ORIGINS` | `http://localhost:5173,...` | Allowlist; anything else gets 403 |
| `OPENAI_API_KEY` | — | **server-only**. Enables replies, translation and streaming |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | For a gateway/proxy |
| `OPENAI_REPLY_MODEL` | `gpt-4o-mini` | Reply + translation model (needs Structured Outputs) |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | Live transcription model |
| `OPENAI_TRANSCRIBE_LANGUAGE` | `en` | Language hint |
| `REALTIME_SILENCE_MS` | `320` | Server-VAD silence before an utterance is finalised |
| `REALTIME_TOKEN_TTL_SECONDS` | `600` | Ephemeral browser token lifetime |
| `MAX_TRANSCRIPT_CHARS` | `4000` | Cost/abuse cap on transcript sent to the model |
| `CONTEXT_WINDOW_TURNS` | `6` | Finalized utterances kept as context |
| `SESSION_TTL_MINUTES` | `120` | Idle session metadata retention |
| `AI_REQUEST_TIMEOUT_MS` | `20000` | Upstream timeout |
| `APP_ACCESS_TOKEN` | — | If set, all API routes except `/health` + `/config` need `Bearer` |
| `RATE_LIMIT_MAX` / `AI_RATE_LIMIT_MAX` | `120` / `40` | Per-IP per-minute buckets |
| `MOCK_AI` | `0` | `1` = deterministic mock provider, clearly labelled |
| `ENABLE_VOCAB_PERSISTENCE` | `0` | Persist saved phrases to a JSON file |
| `VOCAB_FILE` | `.data/vocabulary.json` | Where that file lives |

### Choosing a zero-cost path

| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `openai` | `openai` \| `groq` \| `openai-compatible` \| `local` (Ollama/LM Studio, no key) |
| `AI_API_KEY` | — | Key for the chosen reply provider; ignored for `local` |
| `AI_MODEL` / `AI_BASE_URL` | — | Model id and endpoint override |
| `AI_DAILY_REQUEST_BUDGET` | `200` | Hard per-day cap on AI requests; `0` disables |
| `AI_FAST_PATH` | `1` | Answer provisional replies from the local library (microseconds, free) |
| `PROVISIONAL_MAX_WAIT_MS` | `1800` | Force a provisional reply even if the speaker never pauses |
| `STT_PROVIDER` | `openai-realtime` | `openai-realtime` \| `openai-compatible` \| **`whisper-cpp`** (fully local) |
| `WHISPER_CPP_BIN` | `.local-models/Release/whisper-cli.exe` | Local recogniser, read only when `STT_PROVIDER=whisper-cpp` |
| `WHISPER_CPP_MODE` | `cli` | `cli` = process per chunk; `server` = resident `whisper-server` (measured 1.32× faster per chunk) |
| `WHISPER_CPP_SERVER_URL` | `http://127.0.0.1:8080` | Running server, server mode only — SpeakFlow never launches it |
| `WHISPER_CPP_SERVER_BIN` | `.local-models/Release/whisper-server.exe` | Used only to check the install is present |
| `WHISPER_CPP_MODEL` | `.local-models/ggml-base.en.bin` | Local model file. `ggml-tiny.en.bin` measured 1.7–4.1× faster with equal clean accuracy — `docs/LOCAL_STT.md` |
| `STT_API_KEY` / `STT_BASE_URL` / `STT_MODEL` | — | For the chunked hosted route (`GROQ_API_KEY` is also accepted) |
| `STT_CHUNK_MS` / `STT_SILENCE_MS` | `2400` / `420` | Chunk length and the trailing quiet that closes a chunk early |
| `STT_MAX_REQUESTS_PER_SESSION` | `240` | Caps chunks per call so a retry loop cannot drain a free tier |

`.env` is gitignored; `.env.example` holds placeholders only.

`AI_FAST_PATH=1` plus `STT_PROVIDER=whisper-cpp` is the only combination with
**no quota of any kind** — no account, no key, no request counter. See
`docs/LOCAL_STT.md`.

---

## 5. Provider setup (what a real key unlocks)

A key is **not** required to run the app, and not required to get a working
`speech → transcript → suggestion` loop. Two credential-free paths exist:

| Path | How | Cost |
|---|---|---|
| Fully local | `STT_PROVIDER=whisper-cpp` + `AI_PROVIDER=local` | ₹0, no quota — `docs/LOCAL_STT.md`, `docs/LOCAL_MODEL.md` |
| Labelled demo | `MOCK_AI=1` + *Demo transcript* | ₹0, but every reply is badged `MOCK AI` |

A key adds the things only a hosted service gives: **true interim partials**
(WebRTC realtime transcription) and higher-quality replies.

1. Create a key at platform.openai.com with access to Chat Completions and the Realtime API.
2. Put it in `.env` as `OPENAI_API_KEY`. It is read **only** in `src/server/config.ts` and never
   returned by any endpoint (asserted by a test and by `npm run check:bundle`).
3. Restart the server. `GET /api/config` now reports `aiConfigured: true` and
   `realtimeConfigured: true`.

Verified API surface (checked against OpenAI's published OpenAPI document, not guessed):

- `POST /v1/realtime/client_secrets` with `{ expires_after, session: { type: "transcription", audio: { input: { format, transcription, turn_detection } } } }`
  → `{ value: "ek_…", expires_at, session }`
- `POST /v1/realtime/calls` with `Authorization: Bearer ek_…` and `Content-Type: application/sdp`
  → SDP answer; events arrive on the `oai-events` data channel as
  `input_audio_transcription.delta` / `.completed`
- `POST /v1/chat/completions` with `response_format: { type: "json_schema", json_schema: { strict: true, … } }`

If `/realtime/client_secrets` returns 404 the client automatically falls back to the legacy
`POST /v1/realtime/transcription_sessions`.

---

## 6. Privacy and security

- **No recording.** Audio is not captured to disk anywhere on the server.
- **No transcript persistence.** Transcripts live in the browser tab plus the request payload.
  `POST /api/sessions` rejects `saveTranscript: true` with an explanation instead of silently
  ignoring it. Deleting a session deletes its metadata immediately.
- **Audio path.** WebRTC goes browser → OpenAI directly. Our server only mints a short-lived
  token, so audio does not take an extra hop (latency) and never touches our storage.
- **Redacting logger.** Fields whose key looks like content (`transcript`, `utterance`, `text`,
  `token`, …) are reduced to a length before logging.
- **Errors are safe.** Users get a stable message + request id; stack traces and provider
  payloads stay in server logs.
- **Explicit capture only.** The state machine is
  `Ready → Requesting permission → Connecting → Listening` with visible Pause/Stop, and a
  "Listening" state is only entered after the stream is verified to carry non-silent audio.
  SpeakFlow does not bypass meeting permissions; tab capture uses the browser's own share picker.
- **Workspace gate.** `APP_ACCESS_TOKEN` is a shared secret, not per-user auth.

---

## 7. Testing

```bash
npm test          # 204 tests across 10 files
npm run verify    # lint + typecheck + tests + build + secret scan + extension check
```

Covered (mapping to the spec's acceptance criteria):

| # | Criterion | Where |
|---|---|---|
| 1 | App launches, health responds | `tests/api.test.ts` |
| 2 | Start/stop session | same |
| 3 | Capture failure produces a usable error | `tests/captureErrors.test.ts` (20 tests) |
| 4 | Denied permissions give recovery instructions | `captureErrors.test.ts` + `PermissionExplainer` |
| 5 | Unsupported audio sources reported honestly | `captureErrors.test.ts` + capability chips |
| 6 | Audio verified before transcription | `verifyAudioIsUsable` tests |
| 4 | Transcript updates do not break the UI | bounded segments/partial buffer in `useCopilotSession` |
| 5 | Partial speech triggers preliminary reply | `decideProvisional` tests + `/reply` provisional test |
| 6 | Completed question triggers refined reply | `decideRefined` + `/reply` refined test |
| 7 | Stale replies cannot replace newer ones | `pickReplyForDisplay`, `createSequencer` tests |
| 8 | Ambiguous question → safe response | short-utterance + invalid-output fallback tests |
| 9 | AI output validated against schema | invalid JSON and schema-mismatch tests |
| 10 | Hindi/Hinglish translation preserves intent | translation test asserts prompt + output |
| 11 | Auth and data isolation | access-token test, per-client vocabulary test |
| 12 | No secret in browser code | `npm run check:bundle` |
| 13 | Production frontend builds | `npm run build:web` |
| 14 | Backend tests and typecheck pass | `npm run verify` |
| 15 | Capture stops and releases audio | `captureErrors.test.ts` (track-stop assertions) |
| 16 | Real vs mocked functionality distinguished | `engine: 'mock'` + `Mock AI` badge, asserted in E2E |

### Manual test procedure (needs a real browser and a permitted test call)

1. `npm run dev`, open `http://localhost:5173` in **desktop Chrome or Edge**.
2. Settings → source *OpenAI streaming*, audio *Browser tab*, Save.
3. Click **Start live assistance**, pick a tab playing speech, tick **Also share tab audio**.
4. Confirm: level meter moves; provisional (italic copper) text appears; a `PRELIMINARY` script
   appears *before* the sentence ends; on the pause it flips to `READY TO SAY`.
5. Speak two questions quickly and confirm the older reply is dropped, not shown late.
6. Pause → speaking produces nothing. Resume → transcription continues.
7. Stop → state returns to `Stopped`, browser share indicator clears.
8. Re-share a **silent** tab and confirm you get the "Audio was received but it is silent"
   message and never a false "Listening".
9. Deny the permission once and confirm the actionable error.
10. Pull the network cable mid-call and confirm `Reconnecting…` then a clean failure.

---

## 8. Deployment

### Backend — Render (also serves the SPA)

```
Build command:  npm ci && npm run build
Start command:  npm start
Health check:   /api/health
```

Set in the Render dashboard: `OPENAI_API_KEY`, `APP_ACCESS_TOKEN`, `NODE_ENV=production`,
`CORS_ORIGINS=https://your-frontend.vercel.app`, plus any model overrides.
Render injects `PORT`; the server honours it.

### Frontend only — Vercel

```
Framework: Vite   Build: npm run build:web   Output: dist/client
Env: VITE_API_BASE_URL=https://your-api.onrender.com/api
```

If you host the SPA on Vercel and the API on Render, set `CORS_ORIGINS` on Render to the exact
Vercel origin (and any preview origin you actually use — the allowlist is exact-match on purpose).

### Single-service option

`npm start` serves `dist/client` and the API from one origin, so deploying only the Render
service works with no CORS configuration at all.

Deployment has **not** been performed from this workspace — no credentials were available. The
build and start commands above are verified locally.

### Deployment config files (provided)

| File | Purpose |
|---|---|
| `render.yaml` | Render blueprint: one web service, `npm ci && npm run build`, `npm start`, health check on `/api/health`. Secrets are `sync: false` so they are set in the dashboard, never committed. |
| `vercel.json` | Frontend-only deploy: builds `dist/client`, SPA rewrites that exclude `/api`, immutable asset caching and security headers. |

For the split deployment, also set `VITE_API_BASE_URL` in Vercel (e.g.
`https://speakflow-api.onrender.com/api`) and `CORS_ORIGINS` on Render to the exact
Vercel origin. Without `VITE_API_BASE_URL` the SPA calls `/api` on its own origin and
will 404 against Vercel — that variable is what makes the split deployment work.

### Packaging the extension

```bash
npm run package:extension   # validates first, then writes speakflow-extension.zip
```

The zip has `manifest.json` at its root, which is what the Chrome Web Store expects.
It is *not* published to the Store — that needs a developer account, a listing, a
privacy policy and review.

### Costs and usage limits

SpeakFlow bills nothing itself: every cost is an OpenAI API charge plus hosting.
The dominant driver is the **provisional reply loop**, because it fires repeatedly
while the client is still speaking.

What bounds the spend (all configurable):

| Control | Default | Effect |
|---|---|---|
| `PROVISIONAL_POLICY.minIntervalMs` | 1100 ms | Minimum gap between provisional requests |
| `PROVISIONAL_POLICY.maxRequestsPerUtterance` | 5 | Hard cap per utterance, so a long ramble cannot keep spending |
| material-change check | 4+ new words / rephrase | Unchanged text never re-requests |
| `CONTEXT_WINDOW_TURNS` | 6 | Bounds prompt size, which is the main per-request cost |
| `MAX_TRANSCRIPT_CHARS` | 4000 | Hard cap on transcript sent to the model |
| `AI_RATE_LIMIT_MAX` | 40/min per IP | Stops a runaway loop or abuse |
| `OPENAI_REPLY_MODEL` | `gpt-4o-mini` | Cheapest capable model for replies; swap deliberately |
| circuit breaker | 3 failures → 20 s open | A failing provider stops being called (and billed) |
| `REALTIME_TOKEN_TTL_SECONDS` | 600 | Ephemeral token lifetime |

Rule of thumb: in a 30-minute call with continuous talking, expect roughly one
transcription stream plus a few dozen reply generations — cheap on `gpt-4o-mini`,
and the transcript (not the reply) is what dominates tokens. Measure real usage on
the provider dashboard before promising anything to a user.

**Free-tier warnings:** Render free instances sleep and cold-start (adding seconds to
the first reply), and Vercel's free tier has bandwidth limits. Neither is a problem
for a single user; both matter if several people use one deployment, because
`APP_ACCESS_TOKEN` is one shared secret, not per-user metering.

**Mock mode costs nothing.** `MOCK_AI=1` makes no network calls at all.

---

## 9. Known limitations

- **Tab audio is Chromium-only.** Firefox/Safari cannot share tab audio; use microphone mode.
  `getDisplayMedia` also requires `https` or `localhost`.
- **Browser speech understands only the microphone** and routes audio to the browser vendor's
  service — not to SpeakFlow. It cannot transcribe the client's tab.
- **No speaker diarization.** The transcript is not split into "client" vs "you"; labels are not
  fabricated. The UI calls it one transcript.
- **The reply quality depends on the transcript.** Accented, overlapping or noisy audio yields
  partial sentences; the engine then prefers a safe holding line by design.
- **Provisional replies are intentionally vague.** That is the product decision, not a bug: a
  confident wrong answer mid-sentence is worse than buying two seconds.
- **Single workspace.** `APP_ACCESS_TOKEN` is one shared secret; saved phrases are scoped by a
  browser-generated client id, which is isolation between browsers, not between users. Real
  accounts need Supabase Auth + RLS behind the same service interfaces.
- **Rate limiting is in-memory**, so it resets on redeploy and is per-instance. Swap for Redis
  when scaling horizontally.
- **`confidence` is the model's own estimate**, not a correctness guarantee. Treat
  `facts_to_verify` as the real signal.
- **The fully local route is chunked, not streaming, and misses the ~1 s target.**
  Measured 3868 ms (`cli`) / 2921 ms (`server`) speech→transcript, of which 2 ms
  is reply generation. The gap is CPU inference plus, in `cli` mode, ~950 ms of
  per-chunk process startup — `WHISPER_CPP_MODE=server` removes that half. There
  are **no interim partials**, so the provisional reply cannot fire mid-sentence
  from transcript text alone on that route — `docs/LOCAL_STT.md`.
- **Hindi explanations of the incoming speaker are deliberately absent.** Spec §10
  and the prompt-2 addendum forbid them. Only the *user-authored* Hindi/Hinglish →
  spoken-English translator exists.

### Next steps (in priority order)

1. **One real end-to-end run — at ₹0.** `OPENAI_API_KEY` is **not free** and is
   *not* required for this: use `STT_PROVIDER=whisper-cpp` +
   `AI_PROVIDER=local` (Ollama), open a real meeting tab in Chrome, start capture,
   and record the four stage timings the UI shows. That is what moves a platform in
   `docs/PLATFORM_STATUS.md` towards **Verified**.
   A paid `OPENAI_API_KEY` buys exactly one extra capability: true interim
   partials over WebRTC, and therefore a genuinely mid-sentence provisional reply.
   Nothing else about verification depends on it.
2. Keep the local model resident (`whisper-server.exe` instead of one process per
   chunk). **Done** — `WHISPER_CPP_MODE=server`, measured 1.32× per chunk.
3. Pick the local model deliberately. **Measured** (`npm run bench:models`):
   `tiny.en` is 1.7–4.1× faster than `base.en`, identical on clean speech, and lost
   1 word in 10 sentences under noise (`backend` → `back in`). `tiny.en` is the
   better default for the latency-bound live path.
3. Streaming the reply as tokens so the script starts appearing sooner than a full response.
4. Playwright test for the permission-denied and silent-audio paths.
5. Real auth (Supabase) + RLS, per-user reply history opt-in with retention controls.
6. Saved phrase suggestions injected into the prompt as the user's own voice.

---

## 10. Chrome extension (desktop integration)

Full details in [`extension/README.md`](extension/README.md). In short:

- An MV3 extension captures the **meeting tab you are on** with `chrome.tabCapture`,
  keeps the tab audible, and streams audio over WebRTC to the transcription provider.
- It exists because a page cannot start a tab share without the user re-picking the
  tab each time, and Chrome mutes the tab for the capturer otherwise.
- **The extension never generates replies.** It relays transcript events into the app
  through a content bridge, so there is exactly one reply pipeline for every audio source.
- **The provider key never enters the extension** — it asks the backend for a short-lived
  `ek_…` token, like the web app does.
- Host permission for your app origin is requested **only when you press Start**
  (`optional_host_permissions`), not at install time.

```text
extension/
  manifest.json          MV3, minimum Chrome 116
  src/background.js      service worker: tabCapture, offscreen lifecycle, event relay
  src/offscreen.js       tab audio -> WebRTC -> transcript events
  src/content-bridge.js  injected on demand, window.postMessage to the app
  src/popup.html/.js     app URL, backend URL, token, Start/Stop, live status
```

Install: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.

## 11. Mobile: what is and is not possible

Full report with APIs, permissions, restrictions and tests:
[`docs/PLATFORM_FEASIBILITY.md`](docs/PLATFORM_FEASIBILITY.md).

| Platform | Call type | Status |
|---|---|---|
| Desktop Chrome/Edge | Browser tab meeting | **SUPPORTED — implemented** |
| Desktop | Native app audio (Zoom/Teams/WhatsApp desktop) | NOT IMPLEMENTED (needs OS loopback) |
| Android | SIM / VoLTE call audio | **BLOCKED** — needs system-only `CAPTURE_AUDIO_OUTPUT` |
| Android | WhatsApp / third-party VoIP audio | **BLOCKED** — no supported API |
| iOS | SIM call audio | **UNSUPPORTED** — no public API exists |
| iOS | WhatsApp / third-party VoIP audio | **UNSUPPORTED** — no inter-app audio capture |
| Either | Calls placed *inside our own app* (Twilio/Agora/LiveKit) | Supported approach, not built |

The honest consequence: **there is no mobile call-capture toggle in the product**,
because no ordinary app can capture SIM or WhatsApp call audio on either OS. The
real mobile deliverable is the responsive web app in microphone mode (good for
in-room meetings), subject to the PARTIAL caveats in the report.

The feasibility report carries a **verification caveat**: it was compiled from
documented platform APIs, but could not be re-verified against live documentation
from this workspace (no document-fetching tool, and the web-search tool needs a
Python runtime that is not installed here). Re-check the linked pages and run the
listed practical tests on real devices before building mobile features.

## 12. Verification status (what was actually run)

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | **PASS** — 0 errors |
| Typecheck | `npm run typecheck` | **PASS** — 0 errors |
| Unit + API + UI tests | `npm test` | **PASS** — 203/204 pass; the one failure is the known `ui.test.tsx` load flake, verified passing alone |
| Production build | `npm run build` | **PASS** |
| No secret in client/extension | `npm run check:bundle` | **PASS** — 10 files scanned |
| Extension manifest + syntax | `npm run check:extension` | **PASS** — manifest valid, 4 scripts parsed |
| Reply-engine benchmark | `npm run bench` | **PASS** — p95 0.082 ms |
| Local ₹0 pipeline, real audio | `npm run bench:local` | **PASS** — speech→text 2870 ms, text→reply 2.020 ms |
| Real-browser end-to-end (app) | `node scripts/e2e-browser.mjs` | **PASS** — 21 checks |
| Real-browser extension load | `node scripts/e2e-extension.mjs` | **PASS** — 12 checks incl. offscreen lifecycle |
| End-to-end HTTP pipeline | `scripts/smoke-test.ps1` | **PASS** |

`npm run verify` = lint + typecheck + tests + build + secret scan + extension validation.
`npm run verify:full` adds the browser E2E run.

### The extension really loads in Chrome

`scripts/e2e-extension.mjs` launches Chromium with the unpacked extension and
asks Chrome itself what it accepted:

```text
PASS  service worker registered: chrome-extension://…/src/background.js
PASS  Chrome accepted manifest "SpeakFlow AI — Tab Audio Bridge" v1.0.0 (MV3)
PASS  tabCapture permission present
PASS  offscreen permission present
PASS  chrome.tabCapture API available in the service worker
PASS  chrome.offscreen API available in the service worker
PASS  popup rendered with heading "SpeakFlow AI"
```

This matters because a manifest Chrome rejects fails **silently** — the extension
just never appears. It is a real failure mode, and it is now covered. The offscreen
document is verified too (created with the `USER_MEDIA` reason, page loaded, script
parsed and answered a message, then closed cleanly), which matters because Chrome
refuses to create it if the reason or URL is wrong and the whole capture path would
die quietly.

Still **not** covered: `tabCapture` of an actual meeting tab, `getUserMedia` on the
captured stream, and the WebRTC SDP exchange. Those need a permitted meeting tab
with real audio and `OPENAI_API_KEY`. The script prints that limitation itself
rather than implying otherwise.

### Permission onboarding

Spec §3 requires explaining a permission *before* requesting it. The workspace now
shows a **Before you allow audio** panel while idle, covering the five required
points (why, what, how processed, whether it reaches the cloud, how to stop) plus
storage behaviour, and chips for real capability state:

```
Microphone: Not requested | Granted | Denied | Restricted | Unsupported | Unknown
Tab audio:  Not requested | Granted | Denied | Restricted | Unsupported | Unknown
```

State comes from `navigator.permissions.query` where available. When a browser does
not report state, the UI says **Unknown** rather than guessing — a test asserts it
never claims `Granted` that the browser did not report. Denied and Unsupported each
render recovery instructions instead of a dead end.

### The browser E2E run (`scripts/e2e-browser.mjs`)

This is the check that matters most, because it is the only one that proves the
UI actually renders. It spawns the built server as a child process (a detached
server cannot outlive the shell), drives real Chromium, and asserts:

```text
PASS  React mounted: "Start live assistance" is visible
PASS  boot shell replaced by the app
PASS  panel "Your script" / "Client transcript" / "Say it in English" visible
PASS  Copy script is disabled before a reply exists
PASS  session entered Listening state
PASS  PRELIMINARY reply appeared mid-utterance: "Let me check that and come back to you."
PASS  partial (in-progress) transcript text was visible at the same moment
PASS  reply is explicitly labelled PRELIMINARY
PASS  READY TO SAY reply appeared after completion: "I'll check what's causing the delay..."
PASS  reply is explicitly labelled READY TO SAY
PASS  script card switched from provisional to refined
PASS  1 finalised transcript segment(s) rendered
PASS  Stop returned the UI to Stopped
PASS  no uncaught page exceptions / no console errors
PASS  layout usable at 390px: controls still visible
PASS  extension mode without the extension: honest error instead of a stuck Connecting state
PASS  error includes actionable recovery instructions
```

Screenshots: `.e2e-workspace.png`, `.e2e-mobile.png`.

### Two real bugs this session's verification caught

1. **CORS rejected the app's own assets (critical).** Browsers send an `Origin`
   header on CORS-mode requests — including ES module scripts. The allowlist did
   not contain the serving origin, so `GET /assets/index-*.js` returned **403**,
   the bundle never executed, and `#root` stayed empty while `/` returned 200.
   Every single-service deployment would have shipped a blank page. Fixed in
   `src/server/app.ts` (an origin equal to the request's own host is always
   allowed) and locked down by two regression tests.

2. **A test asserted on prose instead of state.** `getByText(/preliminary/i)`
   matched the explainer list, so the E2E passed before any reply existed. Now
   scoped to `.script-card[data-stage]` and `data-testid="script-stage"`.

### Honest scope of what was proven

Proven: the built app renders; the two-stage pipeline produces a labelled
PRELIMINARY script while text is still partial, then a REFINED script on
completion; version gating, validation, auth, CORS, rate limits and session
cleanup all behave; no secret reaches the browser or the extension.

**Not proven** (needs credentials/a person, not more code): live audio capture and
real streaming transcription. Those runs reported `realtimeConfigured=False`, which
is the server correctly stating that no provider key exists. The demo provider and
mock AI are labelled as such in the UI — see `COVEXCODE.md`.

### Local helper scripts

| Script | Purpose |
|---|---|
| `scripts/smoke-test.ps1` | Start → probe all endpoints → shut down (bounded, safe) |
| `scripts/e2e-browser.mjs` | Real Chromium: mount, two-stage pipeline, mobile, honest failure |
| `scripts/e2e-extension.mjs` | Load the unpacked extension and verify Chrome accepted it |
| `scripts/check-extension.mjs` | Static manifest/reference/syntax validation |
| `scripts/start-detached.ps1` | Run the built server detached (survives the shell) |
| `scripts/stop-detached.ps1` | Stop whatever holds the app port |
| `scripts/diagnose-spa.ps1` | Verify the served bundle/CSS and MIME types |
