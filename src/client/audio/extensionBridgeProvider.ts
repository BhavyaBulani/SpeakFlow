import { captureError } from '../../shared/errors';
import type { ProviderContext, TranscriptionProvider } from './types';

/**
 * Receives transcript events from the SpeakFlow Chrome extension.
 *
 * The extension owns audio acquisition (chrome.tabCapture in an offscreen
 * document) and the WebRTC session; this provider only *listens*. That keeps one
 * reply pipeline for every audio source, which is the whole point of the
 * adapter boundary in the spec.
 *
 * Declared as not consuming a captured stream: this page never calls
 * getDisplayMedia in this mode, so there is no second, competing capture.
 */

const EXTENSION_SOURCE = 'speakflow-extension';
const HANDSHAKE_TIMEOUT_MS = 15_000;

interface BridgeMessage {
  source?: unknown;
  event?: unknown;
}

type EmittableEvent = Parameters<ProviderContext['emit']>[0];
type EventType = EmittableEvent['type'];

const VALID_TYPES: ReadonlySet<string> = new Set<EventType>([
  'partial',
  'final',
  'speech-start',
  'speech-end',
  'status',
  'error',
]);

export class ExtensionBridgeProvider implements TranscriptionProvider {
  readonly id = 'extension-bridge' as const;
  readonly label = 'Chrome extension (tab audio)';
  readonly note =
    'The SpeakFlow extension captures the meeting tab you chose and streams it to the transcription provider, keeping the tab audible. Start capture from the extension popup.';
  readonly consumesCapturedStream = false;

  private context: ProviderContext | null = null;
  private onMessage: ((event: MessageEvent) => void) | null = null;
  private watchdog: number | null = null;
  private sawEvent = false;

  async start(context: ProviderContext): Promise<void> {
    this.context = context;
    this.sawEvent = false;

    const listener = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data as BridgeMessage | null;
      if (data === null || typeof data !== 'object') return;
      if (data.source !== EXTENSION_SOURCE) return;

      const payload = data.event as { type?: unknown } | null;
      if (payload === null || typeof payload !== 'object') return;
      if (typeof payload.type !== 'string' || !VALID_TYPES.has(payload.type)) return;

      this.sawEvent = true;
      this.clearWatchdog();
      context.emit(payload as EmittableEvent);
    };

    this.onMessage = listener;
    window.addEventListener('message', listener);

    context.emit({
      type: 'status',
      status: 'connecting',
      detail: 'Waiting for the SpeakFlow extension to start capturing this tab…',
    });

    // Honest failure: if no extension event arrives, say what to do instead of
    // sitting on a "Connecting" state forever.
    this.watchdog = window.setTimeout(() => {
      if (this.sawEvent || this.context === null) return;
      this.context.emit({
        type: 'error',
        error: captureError('CONNECTION_FAILED', {
          message: 'No audio arrived from the Chrome extension.',
          hint: 'Open the SpeakFlow extension icon on your meeting tab and press "Start capturing", then try again. The extension must also be pointed at this app URL.',
        }),
      });
    }, HANDSHAKE_TIMEOUT_MS);
  }

  stop(): void {
    this.clearWatchdog();
    if (this.onMessage !== null) {
      window.removeEventListener('message', this.onMessage);
      this.onMessage = null;
    }
    // Ask the extension to release the tab capture and stop the stream.
    window.postMessage({ source: 'speakflow-app', type: 'stop' }, window.location.origin);
    this.context = null;
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      window.clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}
