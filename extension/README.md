# SpeakFlow AI — Chrome extension (tab audio bridge)

Manifest V3 extension that captures the **meeting tab you are on** with
`chrome.tabCapture` and streams its audio to the transcription provider, so the
SpeakFlow web app can show a preliminary reply while the client is still talking.

This is the supported desktop path for browser-based meetings (Google Meet,
Teams web, Zoom web, Whereby, Jitsi…). It is *not* a way to capture a native
desktop app's audio, and it cannot capture a call that is not playing in a tab.

---

## Why an extension instead of `getDisplayMedia`

The web app can already share a tab, but a page cannot start that share without
the user picking the tab every single time, and Chrome mutes the tab for the user
unless the capturer re-routes audio. `chrome.tabCapture` gives an explicit,
per-tab, user-initiated grant that survives the whole call.

## How it works

```
popup  ──capture:start(tabId)──▶  service worker
                                     │  chrome.tabCapture.getMediaStreamId
                                     │  creates offscreen document (USER_MEDIA)
                                     ▼
                              offscreen document
                                · getUserMedia(tab audio, streamId)
                                · re-routes audio to speakers (tab stays audible)
                                · POST /api/realtime/token  (ephemeral ek_… token)
                                · WebRTC ──▶ provider /realtime/calls
                                · data channel: input_audio_transcription.delta/.completed
                                     │
                                     ▼
                              service worker ──▶ app tab (content bridge)
                                     │            window.postMessage
                                     ▼
                        SpeakFlow web app: provisional + refined replies
```

Design decisions worth knowing:

- **The extension never generates replies.** It only acquires audio and relays
  transcript events, so there is exactly one reply pipeline (`src/shared/replyPipeline.ts`).
- **The provider key never enters the extension.** It asks our backend for a
  short-lived `ek_…` token, exactly like the web app does.
- **Audio goes browser → provider directly.** No extra hop through our server.
- **The content bridge is injected on demand** for the app URL you configure, so
  the extension does not request `<all_urls>` at install time.
- **Silence is reported, not hidden.** After connecting, the pipeline samples the
  stream and warns if the tab is silent (muted meeting, wrong tab).

## Install (development / unpacked)

1. Build the app and start it: `npm run build && npm start` → `http://localhost:8787`
   (or `npm run dev` → `http://localhost:5173`).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select this `extension/` directory.
4. Click the extension icon on a **meeting tab**.
5. Set:
   - *SpeakFlow app URL* — where the web app runs
   - *Backend API URL* — e.g. `http://localhost:8787/api`
   - *Workspace access token* — only if the server sets `APP_ACCESS_TOKEN`
6. Press **Start capturing**. Chrome asks once for permission to reach the app
   origin. The SpeakFlow tab opens automatically if it is not already there.
7. In the web app: Settings → transcription source → **Chrome extension (tab
   audio)** → Start live assistance.

## Packaging

```bash
cd extension && zip -r ../speakflow-extension.zip . -x "*.DS_Store"
```

For the Chrome Web Store you need a store listing, a privacy policy, and a
justification for `tabCapture`. `optional_host_permissions` is used on purpose:
requesting the app origin only at the moment the user presses Start is a smaller
review surface than a broad host permission.

## Permissions, and exactly why each one exists

| Permission | Why | When requested |
|---|---|---|
| `tabCapture` | Capture the chosen tab's audio | Install |
| `offscreen` | MV3 service workers cannot hold a MediaStream | Install |
| `storage` | Remember the app/backend URLs | Install |
| `scripting` | Inject the bridge into the app tab on demand | Install |
| `tabs` | Find the app tab, detect when the captured tab closes | Install |
| host `https://api.openai.com/*` | WebRTC SDP exchange | Install |
| host `<your app origin>` | Inject the bridge | **Only when you press Start** |

## Honest limitations

- **Chromium only** (Chrome/Edge 116+). Firefox and Safari have no equivalent
  `tabCapture`/offscreen combination.
- **Only browser tabs.** A native Zoom/Teams/WhatsApp *desktop app* playing audio
  outside a tab cannot be captured by `tabCapture`. On Windows that would need
  system loopback capture, which is a different (unimplemented) adapter.
- **Screen-record permission still applies.** Chrome shows its own capture
  indicator; this extension cannot and will not hide it.
- **Requires the web app to be reachable.** If the app tab is gone and cannot be
  opened, events are dropped and the popup tells you so.
- **No phone calls.** See `docs/PLATFORM_FEASIBILITY.md` — SIM and WhatsApp calls
  are BLOCKED on both Android and iOS, and no extension can change that.
