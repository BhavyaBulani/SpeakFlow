# Platform feasibility report — same-device call audio

**Status: research complete for the desktop path and for Android/iOS. The mobile
call-capture cases are BLOCKED or UNSUPPORTED, and this document says so instead
of shipping a button that cannot work.**

Scope: SpeakFlow must run on **the same device** that is in the call. No second
phone, no external speakerphone, no remote microphone. This report covers what is
genuinely reachable by an ordinary third-party app on each platform.

## Verification caveat (read this first)

This report was compiled from the documented, stable platform APIs below (their
permission models have not changed in a way that affects these conclusions).
It could **not** be re-verified against live documentation from this workspace:
no browser/network document tooling is available here, and the automated
web-search tool requires a Python runtime that is not installed.

Before shipping mobile work, re-check the linked pages and run the practical test
in each section on a real device. Each case is marked with the exact test that
would confirm or refute it. Do not upgrade a status from BLOCKED to SUPPORTED
based on this document alone.

## Summary matrix

| Platform | Call type | Status | Why |
|---|---|---|---|
| Desktop Chrome/Edge | Browser tab meeting (Meet, Teams web, Zoom web, Jitsi…) | **SUPPORTED — implemented** | `chrome.tabCapture` + offscreen document, with explicit per-tab user grant |
| Desktop (any) | Native desktop app audio (Zoom/Teams/WhatsApp desktop) | **NOT IMPLEMENTED** | Needs OS loopback capture (WASAPI on Windows, virtual device on macOS) — a different adapter |
| Web (any browser) | In-room audio via microphone | **SUPPORTED — implemented** | `getUserMedia({audio})`, verified before transcription starts |
| Web (Safari/Firefox) | Tab audio | **UNSUPPORTED** | No `getDisplayMedia` tab-audio support |
| Android | In-room audio via microphone while on speaker | **PARTIAL** | Permission works; capture during an active cellular call is device-dependent and often silent |
| Android | SIM / VoLTE call audio | **BLOCKED** | Requires system-only `CAPTURE_AUDIO_OUTPUT`; playback capture excludes call audio |
| Android | WhatsApp (or other third-party VoIP) call audio | **BLOCKED** | Not capturable by any supported API; app-controlled, E2E-encrypted audio |
| Android | A call placed *inside our own app* (Twilio/Agora/LiveKit) | **SUPPORTED (approach)** | We own the audio session; not yet built |
| iOS | In-room audio via microphone while on speaker | **PARTIAL** | `AVAudioSession` `.playAndRecord`; cellular-call interaction needs device testing |
| iOS | SIM / cellular call audio | **UNSUPPORTED** | No public API exists; no process may tap the modem audio path |
| iOS | WhatsApp / third-party VoIP call audio | **UNSUPPORTED** | No inter-app audio capture; ReplayKit captures only our own app |
| iOS | A call placed *inside our own app* (CallKit + WebRTC/Twilio) | **SUPPORTED (approach)** | Standard VoIP integration; not yet built |
| Both | WhatsApp call audio via any workaround | **BLOCKED** | No official capture path; the "workarounds" are root/jailbreak or screen-record hacks that violate platform rules |

---

## Android

### 1. SIM / VoLTE call audio — BLOCKED

- **APIs / docs:** `MediaRecorder.AudioSource` (`VOICE_CALL`, `VOICE_DOWNLINK`,
  `VOICE_UPLINK`), `android.permission.CAPTURE_AUDIO_OUTPUT`,
  `AudioPlaybackCaptureConfiguration` (API 29+).
  <https://developer.android.com/reference/android/media/MediaRecorder.AudioSource>
  <https://developer.android.com/reference/android/Manifest.permission#CAPTURE_AUDIO_OUTPUT>
  <https://developer.android.com/media/platform/av-capture>
- **Required permissions:** `VOICE_CALL`/`VOICE_DOWNLINK` sources require
  `CAPTURE_AUDIO_OUTPUT`, which is `signature|privileged`. An ordinary Play Store
  app cannot hold it; it is reserved for system/privileged apps (dialer, OEM).
- **Technical restriction:** the telephony audio path is inside the modem/DSP
  pipeline and is not exposed to third-party processes. `MediaProjection` +
  `AudioPlaybackCaptureConfiguration` only receives audio from apps whose
  playback attributes opt in (`ALLOW_CAPTURE_BY_ALL` with usages such as
  `MEDIA`/`GAME`/`UNKNOWN`). Telephony uses `VOICE_COMMUNICATION`, which is
  excluded by design.
- **Implementation approach:** none that is legitimate. Any app that claims to
  record call audio on an unrooted, unprivileged device is either recording the
  microphone (not the call) or using a system privilege we do not have.
- **Practical test:** start a speaker-enabled cellular call, run
  `AudioRecord` with `MIC` source for 30 s, and log peak amplitude; then repeat
  with `VOICE_CALL` and observe `SecurityException` / silence. Expectation:
  `VOICE_CALL` throws or silently fails; `MIC` is unreliable while the call is up.

### 2. WhatsApp / third-party VoIP call audio — BLOCKED

- **APIs / docs:** the same `AudioPlaybackCaptureConfiguration` page above is the
  only system-wide audio route, and it cannot see other apps' voice-communication
  audio. WhatsApp publishes no call-audio API; the WhatsApp Business Platform
  (Cloud API) is for messaging, not call media.
- **Required permissions:** none exist that grant this.
- **Technical restriction:** the other app's audio is decoded inside its own
  process and routed as `USAGE_VOICE_COMMUNICATION`; it is also end-to-end
  encrypted by policy.
- **Implementation approach:** none. Screen recording with audio
  (`MediaProjection` audio) captures *media*, so it will not contain call audio.
- **Practical test:** play a WhatsApp voice call on speaker, run a
  `MediaProjection`-based audio capture for 30 s, and inspect the decoded RMS.
  Expectation: near-zero / no call speech.

### 3. Microphone while on speaker — PARTIAL (implemented for the web app only)

- **APIs:** `RECORD_AUDIO` + `AudioRecord`/`MediaRecorder`. Officially supported
  permission, no special policy needed beyond a clear rationale.
- **Restriction:** during an active cellular call many devices route or gate the
  microphone for the call's own use; results range from usable to silent. Echo
  from the speaker also degrades accuracy.
- **Approach:** only worth shipping behind an explicit warning and a device test
  matrix. On the web this is the existing **microphone** mode, which verifies
  audio level before showing "Listening".
- **Practical test:** device matrix (at least 3 OEMs, 2 Android versions), 30 s of
  speech per run while on a speaker call, measure transcript accuracy.

### 4. Calling inside our own app — SUPPORTED approach (not built)

- Integrate a VoIP provider SDK (Twilio Voice, Agora, LiveKit, Vonage) so calls
  are placed from our app. We then own the audio session and can tap both
  directions.
- **Requires:** business/account setup with the provider, a backend to mint
  access tokens, `RECORD_AUDIO`, and (for incoming calls) a foreground service
  with `microphone` type plus notification permission on Android 14+.
- This is the only legitimate path to full call audio on Android. It is a
  product decision (users must call through SpeakFlow), not a capture trick.

---

## iOS

### 1. SIM / cellular call audio — UNSUPPORTED

- **APIs / docs:** `AVAudioSession` (governs only our own app's I/O),
  `CallKit`/`CXProvider` (call UI/management, still our app's audio).
  <https://developer.apple.com/documentation/avfaudio/avaudiosession>
  <https://developer.apple.com/documentation/callkit>
- **Required entitlements:** none exist for capturing the cellular call audio
  path. There is no public "record the phone call" API. Apple's own call
  recording features are system-level.
- **Technical restriction:** the cellular call's audio never enters third-party
  process memory. `AVAudioSession` category changes affect our session only, and
  activating a `.playAndRecord` session during a cellular call typically causes
  the call audio to duck or the session to be interrupted.
- **Practical test:** on a real device, attempt `AVAudioEngine` input tap during a
  cellular call and log buffer RMS. Expectation: silence or an interruption
  notification — never the far-end caller's audio.

### 2. WhatsApp / third-party VoIP call audio — UNSUPPORTED

- **APIs / docs:** `ReplayKit` (`RPScreenRecorder`) captures our own app's audio
  and (with user consent) the screen plus microphone — not other apps' audio
  output. There is no inter-app audio tap.
  <https://developer.apple.com/documentation/replaykit>
- **Restriction:** another app's audio output is not exposed to us, and WhatsApp
  publishes no call-audio API.
- **Practical test:** run an `RPScreenRecorder` capture while a WhatsApp call is
  active on speaker; inspect the audio track. Expectation: no call speech.

### 3. Microphone while on speaker — PARTIAL

- `AVAudioSession` category `.playAndRecord` with `.defaultToSpeaker`; needs
  `NSMicrophoneUsageDescription`. During a cellular call the session is usually
  interrupted, so this is realistically only usable for in-room meetings
  (e.g. phone on the table in a meeting room).
- **Practical test:** same as Android §3 — accuracy measurement per device.

### 4. Calling inside our own app — SUPPORTED approach (not built)

- **CallKit** for system call UI + **WebRTC** or **Twilio Voice iOS SDK** for
  media. We own the audio session, so transcription of both sides is possible.
- **Requires:** VoIP push notifications (`PushKit` + `CXProvider` reporting),
  a provider account, a token-minting backend, and App Store review justification
  for background audio.

---

## What this means for the product

1. **Desktop browser meetings are the supported path today** and are implemented:
   the Chrome extension (tab audio) and microphone mode both feed one reply
   pipeline.
2. **Phone calls (SIM or WhatsApp) cannot be captured on either mobile OS** by an
   ordinary app. Any marketing or UI that implies otherwise would be a lie, so
   there is no mobile call-capture toggle in the product.
3. If phone-call coverage becomes a business requirement, the only honest route is
   **routing calls through a VoIP provider SDK** (§Android 4 / §iOS 4), which turns
   the problem into "we own the call" — a scoped project, not a permission request.
4. The **mobile-friendly deliverable** that is real today is the responsive web
   app in microphone mode (works in Chrome on Android and Safari on iOS over
   HTTPS, subject to the PARTIAL caveats above).

## Re-verification checklist

- [ ] Android: `CAPTURE_AUDIO_OUTPUT` still `signature|privileged`
- [ ] Android: `AudioPlaybackCaptureConfiguration` still excludes
      `USAGE_VOICE_COMMUNICATION`
- [ ] iOS: no new public API for cellular/VoIP inter-app audio capture
- [ ] WhatsApp Business Platform: still no call-media API
- [ ] Chrome: `chrome.tabCapture.getMediaStreamId` + `offscreen` still the
      documented tab-audio path
