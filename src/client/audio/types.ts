import type { CaptureError as CaptureErrorShape } from '../../shared/errors';
import type { SessionStatus, TranscriptionProviderId } from '../../shared/types';

/**
 * The provider boundary. Everything above this interface (the copilot hook and
 * the UI) is provider-agnostic, which is what lets real streaming, browser
 * speech and the simulated demo share one code path.
 */

export type TranscriptionEvent =
  /** Interim text for the utterance currently being spoken. Replaces previous partial. */
  | { type: 'partial'; text: string; at: number }
  /** A finished utterance. Appended to the transcript. */
  | { type: 'final'; text: string; at: number }
  /** Voice activity detected - the earliest point we can start measuring from. */
  | { type: 'speech-start'; at: number }
  /** Voice activity ended - candidate utterance boundary. */
  | { type: 'speech-end'; at: number }
  /**
   * Audio was lost (dropped frames, queue overflow, a gap in the sequence).
   * The transcript from here on must not be presented as continuous speech, so
   * the UI surfaces this instead of silently pretending nothing happened.
   */
  | { type: 'context-uncertain'; reason: string; at: number }
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'error'; error: CaptureErrorShape };

export interface ProviderContext {
  /** Null only for the simulated provider, which does not read audio. */
  stream: MediaStream | null;
  emit: (event: TranscriptionEvent) => void;
  signal: AbortSignal;
  /** Fetches a short-lived realtime token from our own backend. */
  getRealtimeToken: () => Promise<{
    token: string;
    expiresAt: number;
    model: string;
    transport: { sdpUrl: string; dataChannel: string; sampleRate: number };
  }>;
  /**
   * Optional because only the chunked provider uses it: sends one
   * self-contained WAV chunk to our backend and resolves with its text.
   * Present only when a server session already exists.
   */
  transcribeChunk?: (input: {
    seq: number;
    startSample: number;
    wavBase64: string;
  }) => Promise<{ text: string; mode: string }>;
}

export interface TranscriptionProvider {
  readonly id: TranscriptionProviderId;
  readonly label: string;
  /** One line shown in the UI about what this provider does with audio. */
  readonly note: string;
  /** False for providers that create their own audio source (browser speech) or none (demo). */
  readonly consumesCapturedStream: boolean;
  start(context: ProviderContext): Promise<void>;
  stop(): void;
}
