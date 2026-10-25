# Platform and audio-source status

`prompt_2.txt` §11.7 requires one status per platform, and forbids marking
anything **Verified** on the basis of compilation, a successful launch, or mock
data. This table obeys that rule strictly.

| Status | Meaning |
|---|---|
| **Verified** | Real audio captured and an end-to-end reply produced, tested. |
| **Partially supported** | Code path exists and is unit/integration tested, but real capture of real call audio has **not** been confirmed. |
| **Unsupported** | No reliable, authorised capture path exists or is implemented. |

## Where capture comes from

```
browser tab audio  ─┐
microphone         ─┼─> ordered audio frames ─> streaming STT ─> transcript ─> reply engine ─> UI
desktop loopback   ─┘        (shared pipeline; only the adapter differs)
```

## Status table

| Target | Adapter | Status | Evidence / blocker |
|---|---|---|---|
| Google Meet (Chrome tab) | `extension-bridge` (`chrome.tabCapture`) + `openai-realtime` | **Partially supported** | Extension is proven to load in real Chromium, register its service worker, expose `tabCapture`/`offscreen`, and create+close the offscreen document (`scripts/e2e-extension.mjs`, 12 checks). Capturing an actual Meet tab and confirming headset playback is **manual and unperformed** — clicking the extension action cannot be automated. |
| Discord in a browser | same | **Partially supported** | Same path as Meet; not individually tested. Some Discord audio may be WebAudio-synthesised — verify before claiming. |
| Slack calls in a browser | same | **Partially supported** | Same path; not individually tested. |
| WhatsApp Web calls | same | **Partially supported** | Same path; specifically **untested**. WhatsApp Web call audio has historically resisted tab capture in some configurations. |
| Interview platforms (browser) | same | **Partially supported** | Same path; not individually tested. |
| Microphone (in-room meeting) | `browser-speech` or `chunked-stt` + mic | **Partially supported** | `getUserMedia` capture, silent-stream detection and level monitoring are implemented and unit tested. Browser speech cannot transcribe a browser tab, only the mic. |
| Desktop Discord / Slack / Zoom / Teams / WhatsApp Desktop | **System audio** via `getDisplayMedia` + "Share system audio" (Windows Chrome), *or* a WASAPI companion | **Partially supported** | The browser route needs no companion: on Windows Chrome, picking **Entire Screen** (or a window) offers a **"Share system audio"** checkbox, and that audio reaches SpeakFlow. Implemented as capture mode `system`; **not yet tested against a real desktop call**. WASAPI companion: **not built** — no `dotnet`/`csc` toolchain exists on this machine, so it could be neither built nor verified. |
| Android SIM / VoLTE calls | none | **Unsupported** | Requires system-only `CAPTURE_AUDIO_OUTPUT`. Ordinary apps cannot capture call audio. |
| Android WhatsApp / third-party VoIP | none | **Unsupported** | No supported API for inter-app audio capture. |
| iOS SIM calls | none | **Unsupported** | No public API exists for third-party call-audio capture. |
| iOS WhatsApp / third-party VoIP | none | **Unsupported** | No inter-app audio capture on iOS. |

No platform is marked **Verified**. That is deliberate: a credential and a real
call were never available in this environment, and the honest status of
"implemented and tested at the seams, not yet proven on real audio" is
**Partially supported**.

## What "partially supported" was actually proven against

Real, automated, no credentials needed:

- `scripts/e2e-browser.mjs` — 21 checks in real Chromium: React mounts, capture
  state machine reaches Listening, a provisional reply appears while text is
  still partial, the refined reply replaces it, Stop returns to Stopped, no
  console errors, layout usable at 390 px.
- `scripts/e2e-extension.mjs` — 12 checks: Chrome accepts the MV3 manifest,
  service worker registers, `tabCapture`/`offscreen` APIs present, offscreen
  document lifecycle works.
- `tests/audioFraming.test.ts`, `tests/stt.test.ts` — framing, gap detection,
  bounded queues, WAV encoding, provider error mapping.

Not proven: that a human's voice actually reaches the pipeline from a Meet,
Zoom, Discord, Slack, Teams or WhatsApp call, and that headset playback is
unaffected. Those require a person, a call, and a key.

## Headset playback

The design does not touch the audio path the user hears:

- **Tab capture (extension):** the extension keeps the tab audible
  (`chrome.tabCapture` with the tab left unmuted) and relays a copy over WebRTC.
- **Chunked mode:** audio is copied into an `AudioContext` and pushed through a
  zero-gain sink node, so the captured stream is never routed to the speakers.
  (Echoing the client's voice back at them would be an obvious failure.)

Whether a Bluetooth headset stays uninterrupted through either route is
**untested on real hardware**. Hands-free vs A2DP profile switching is a known
Windows/Bluetooth failure mode and must be checked on a real device before this
is claimed as working.

## Getting a desktop source working later

The cheapest next step, once a C#/Rust/Node loopback tool exists, is:

1. Call `POST /api/sessions` to get a session id.
2. Capture loopback audio at 16 kHz mono.
3. Frame it with `ChunkAssembler` from `src/shared/audioFraming.ts` (same rules
   as the browser: silence close, hard max-wait, drop room tone).
4. POST each chunk to `/api/stt/chunk` with base64 WAV.

That reuses the entire existing pipeline; no reply or transcription code is
duplicated per platform, as `prompt_2.txt` §11.3 requires.
