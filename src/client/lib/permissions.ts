/**
 * Permission state detection for the onboarding explainer.
 *
 * Spec requirement: show explicit states — Not requested, Granted, Denied,
 * Restricted, Unsupported — and never imply a grant that did not happen.
 *
 * `navigator.permissions.query` is the only browser API that reports the real
 * state without triggering a prompt. Support varies (`display-capture` is not
 * queryable in every Chrome version), so every unknown is reported honestly as
 * `unknown` rather than guessed.
 */

export type CapabilityState =
  | 'not-requested'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unsupported'
  | 'unknown';

export interface CapabilityStatus {
  id: 'microphone' | 'tab-audio';
  label: string;
  state: CapabilityState;
  /** What the state means for the user right now. */
  detail: string;
}

export interface PermissionSnapshot {
  microphone: CapabilityStatus;
  tabAudio: CapabilityStatus;
}

const STATE_LABEL: Record<CapabilityState, string> = {
  'not-requested': 'Not requested',
  granted: 'Granted',
  denied: 'Denied',
  restricted: 'Restricted',
  unsupported: 'Unsupported',
  unknown: 'Unknown',
};

export function capabilityStateLabel(state: CapabilityState): string {
  return STATE_LABEL[state];
}

function mapBrowserState(value: PermissionState | string): CapabilityState {
  if (value === 'granted') return 'granted';
  if (value === 'denied') return 'denied';
  if (value === 'prompt') return 'not-requested';
  return 'unknown';
}

const MIC_DETAIL: Record<CapabilityState, string> = {
  'not-requested':
    'SpeakFlow will ask the browser the first time you press Start. Nothing is captured before that.',
  granted: 'The browser has allowed microphone access for this site. Capture still starts only when you press Start.',
  denied:
    'The browser is blocking the microphone. Open the padlock icon in the address bar, allow Microphone, then reload.',
  restricted: 'Your browser or operating system restricts microphone access for this site.',
  unsupported: 'This browser cannot capture audio at all. Use a current Chrome, Edge, Firefox or Safari.',
  unknown: 'The browser does not report microphone state. You will still see the real prompt when you press Start.',
};

const TAB_DETAIL: Record<CapabilityState, string> = {
  'not-requested':
    'Chrome will show its own share picker when you press Start. You choose the tab, and nothing is shared before that.',
  granted: 'Tab sharing is currently allowed for this site. Any active share is shown by the browser itself.',
  denied: 'Tab sharing was blocked. Allow screen/tab capture for this site in the address-bar permissions, then reload.',
  restricted: 'This page cannot request tab audio — it needs https or localhost, and a Chromium browser.',
  unsupported:
    'This browser cannot share tab audio (Firefox and Safari do not support it). Use the microphone, or the Chrome extension.',
  unknown: 'Tab-audio state is not reported by this browser. The real picker appears when you press Start.',
};

/**
 * Reads current capability state. Never prompts.
 * Call `watchCapabilities` to keep it live.
 */
export async function detectCapabilities(): Promise<PermissionSnapshot> {
  const hasMediaDevices =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices === 'object';

  const canGetUserMedia = hasMediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
  const canGetDisplayMedia = hasMediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function';
  const isSecureContext = typeof window !== 'undefined' ? window.isSecureContext : true;

  let microphoneState: CapabilityState = canGetUserMedia ? 'not-requested' : 'unsupported';
  let tabState: CapabilityState = !canGetDisplayMedia || !isSecureContext ? 'unsupported' : 'not-requested';

  const query = navigator.permissions?.query?.bind(navigator.permissions);
  if (typeof query === 'function' && canGetUserMedia) {
    try {
      const status = await query({ name: 'microphone' as PermissionName });
      microphoneState = mapBrowserState(status.state);
    } catch {
      // Some browsers throw for unknown names; keep the honest default.
      microphoneState = canGetUserMedia ? 'unknown' : 'unsupported';
    }
  }

  if (tabState !== 'unsupported' && typeof query === 'function') {
    try {
      // Not supported everywhere - a failure here is expected, not an error.
      const status = await query({ name: 'display-capture' as PermissionName });
      tabState = mapBrowserState(status.state);
    } catch {
      tabState = 'unknown';
    }
  }

  return {
    microphone: {
      id: 'microphone',
      label: 'Microphone',
      state: microphoneState,
      detail: MIC_DETAIL[microphoneState],
    },
    tabAudio: {
      id: 'tab-audio',
      label: 'Tab audio',
      state: tabState,
      detail: TAB_DETAIL[tabState],
    },
  };
}

/**
 * Subscribes to permission changes and calls back with a fresh snapshot.
 * Returns an unsubscribe function. Silently no-ops where unsupported.
 */
export function watchCapabilities(onChange: (snapshot: PermissionSnapshot) => void): () => void {
  const cleanups: Array<() => void> = [];
  let closed = false;

  void detectCapabilities().then((snapshot) => {
    if (!closed) onChange(snapshot);
  });

  const query = navigator.permissions?.query?.bind(navigator.permissions);
  if (typeof query !== 'function') return () => { closed = true; };

  for (const name of ['microphone', 'display-capture'] as PermissionName[]) {
    query({ name })
      .then((status) => {
        const handler = (): void => {
          void detectCapabilities().then((snapshot) => {
            if (!closed) onChange(snapshot);
          });
        };
        status.addEventListener('change', handler);
        cleanups.push(() => status.removeEventListener('change', handler));
      })
      .catch(() => undefined);
  }

  return () => {
    closed = true;
    for (const cleanup of cleanups) cleanup();
  };
}

/** The five things the spec requires explaining before a permission prompt. */
export interface PermissionExplainerItem {
  question: string;
  answer: string;
}

export function explainerItems(input: {
  provider: 'openai-realtime' | 'chunked-stt' | 'browser-speech' | 'simulated' | 'extension-bridge';
  captureMode: 'tab' | 'system' | 'microphone' | 'demo';
}): PermissionExplainerItem[] {
  const usingExtension = input.provider === 'extension-bridge';
  const simulated = input.provider === 'simulated';
  const browserSpeech = input.provider === 'browser-speech';
  const chunked = input.provider === 'chunked-stt';
  const usingSystem = input.captureMode === 'system';

  const why = simulated
    ? 'Nothing is requested: the demo transcript replays a scripted conversation so you can try the reply pipeline.'
    : usingExtension
      ? 'The Chrome extension needs permission to capture the audio of the tab you select. You choose the tab; it is never chosen for you.'
      : usingSystem
        ? 'System-audio mode lets SpeakFlow hear everything this computer plays, which is how it reaches a DESKTOP call (Zoom, Teams, Discord, Slack). Chrome asks you to pick a screen or window and to tick "Share system audio".'
        : input.captureMode === 'tab'
          ? 'Tab audio lets SpeakFlow hear the meeting playing in your browser tab. Without it there is nothing to transcribe.'
          : 'Microphone access lets SpeakFlow hear the meeting through your device. Without it there is nothing to transcribe.';

  const what = simulated
    ? 'No audio, no microphone and no tab audio are accessed at all.'
    : usingExtension
      ? "The tab's audio track only. The tab stays audible, and SpeakFlow never records it to disk."
      : usingSystem
        ? 'Whatever this computer is playing at that moment - including other applications - not just the window you picked. Your headset keeps playing the call normally. Chrome keeps its sharing indicator visible for the whole session.'
        : input.captureMode === 'tab'
          ? "The audio track of the one tab you pick. Chrome shows its own sharing indicator and stays visible for the whole session."
          : 'Live audio from your microphone while the session is running.';

  const processing = browserSpeech
    ? 'Your browser’s built-in speech recogniser converts speech to text. The audio goes to your browser vendor, not to SpeakFlow.'
    : chunked
      ? 'Audio is cut into short chunks in this browser and sent through the SpeakFlow server to the speech-to-text provider. Text appears as each chunk is recognised - a couple of seconds behind the speaker, not word by word.'
      : 'Audio is streamed to the speech-to-text provider to produce a live transcript. Transcript text is then sent to the AI provider to draft a reply.';

  const cloud = simulated
    ? 'Only the scripted text goes to the SpeakFlow server. No audio leaves this device.'
    : usingExtension
      ? 'Audio goes directly from this browser to OpenAI over WebRTC, using a short-lived token from your SpeakFlow server. It does not pass through our backend, and the permanent API key stays on the server.'
      : browserSpeech
        ? 'Audio goes to your browser vendor’s speech service. Only the resulting text reaches the SpeakFlow server.'
        : chunked
          ? 'Audio chunks go from this browser to your SpeakFlow server, which forwards them to the configured speech-to-text provider. Unlike the streaming mode, audio does pass through the backend, in memory, for the length of one request. The provider key stays on the server.'
          : 'Audio goes to OpenAI for transcription and the transcript to OpenAI for the reply. Both happen over encrypted connections.';

  const stop = usingExtension
    ? 'Press Stop in the extension popup or in SpeakFlow. Stopping in either place releases the tab capture immediately.'
    : 'Press Stop or Pause. Stop releases the microphone/tab and clears the session. Reloading the page also releases everything.';

  return [
    { question: 'Why is it needed?', answer: why },
    { question: 'What does it access?', answer: what },
    { question: 'How is it processed?', answer: processing },
    { question: 'Does it go to the cloud?', answer: cloud },
    { question: 'How do I stop it?', answer: stop },
  ];
}
