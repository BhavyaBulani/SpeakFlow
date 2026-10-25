import { captureError } from '../../shared/errors';
import type { ProviderContext, TranscriptionProvider } from './types';

/**
 * Fallback provider using the browser's built-in speech recogniser.
 *
 * Honest limitation: `SpeechRecognition` can only listen to the microphone - it
 * cannot be fed a tab audio stream - and Chrome sends that audio to its own
 * cloud recogniser, not to SpeakFlow. The provider therefore reports
 * `consumesCapturedStream = false`, the UI restricts it to microphone mode, and
 * the privacy note says this plainly.
 */

interface SpeechAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike | undefined;
}

interface SpeechResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechResultLike | undefined;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechResultListLike;
}

interface SpeechRecognitionErrorLike {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getConstructor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const candidate = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

export class BrowserSpeechProvider implements TranscriptionProvider {
  readonly id = 'browser-speech' as const;
  readonly label = 'Browser speech';
  readonly note =
    "Uses your browser's built-in recogniser, which sends microphone audio to the browser vendor (Google in Chrome). SpeakFlow does not receive or store it. Microphone mode only.";
  readonly consumesCapturedStream = false;

  private recognition: SpeechRecognitionLike | null = null;
  private stopped = true;
  private inUtterance = false;
  private restarts = 0;

  async start(context: ProviderContext): Promise<void> {
    const ctor = getConstructor();
    if (ctor === null) {
      context.emit({ type: 'error', error: captureError('UNSUPPORTED_BROWSER') });
      return;
    }

    this.stopped = false;
    this.restarts = 0;
    context.emit({ type: 'status', status: 'connecting' });

    const recognition = new ctor();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      if (this.stopped) return;
      context.emit({ type: 'status', status: 'listening' });
    };

    recognition.onresult = (event) => {
      if (this.stopped) return;
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result === undefined) continue;
        const alternative = result[0];
        const transcript = alternative?.transcript?.trim() ?? '';
        if (transcript.length === 0) continue;

        if (result.isFinal) {
          if (!this.inUtterance) {
            context.emit({ type: 'speech-start', at: Date.now() });
            this.inUtterance = true;
          }
          context.emit({ type: 'final', text: transcript, at: Date.now() });
          context.emit({ type: 'speech-end', at: Date.now() });
          this.inUtterance = false;
        } else {
          if (!this.inUtterance) {
            context.emit({ type: 'speech-start', at: Date.now() });
            this.inUtterance = true;
          }
          interim = interim.length === 0 ? transcript : `${interim} ${transcript}`;
        }
      }
      if (interim.length > 0) {
        context.emit({ type: 'partial', text: interim, at: Date.now() });
      }
    };

    recognition.onerror = (event) => {
      if (this.stopped) return;
      switch (event.error) {
        case 'no-speech':
        case 'aborted':
          return;
        case 'not-allowed':
        case 'service-not-allowed':
          this.stopped = true;
          context.emit({ type: 'error', error: captureError('PERMISSION_DENIED') });
          return;
        case 'audio-capture':
          context.emit({ type: 'error', error: captureError('NO_AUDIO_TRACK') });
          return;
        case 'network':
          context.emit({ type: 'error', error: captureError('CONNECTION_FAILED') });
          return;
        default:
          context.emit({
            type: 'error',
            error: captureError('UNKNOWN', { message: `Browser speech error: ${event.error}` }),
          });
      }
    };

    recognition.onend = () => {
      if (this.stopped) return;
      // Chrome ends recognition after a pause; restart to stay continuous,
      // but stop trying if it keeps dying immediately.
      this.restarts += 1;
      if (this.restarts > 40) {
        this.stopped = true;
        context.emit({
          type: 'error',
          error: captureError('CONNECTION_FAILED', {
            message: 'Browser speech stopped unexpectedly.',
            hint: 'Switch to OpenAI streaming if it is configured, or reload the page.',
          }),
        });
        return;
      }
      try {
        recognition.start();
      } catch {
        // start() throws if a session is still active; ignore.
      }
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      context.emit({
        type: 'error',
        error: captureError('UNSUPPORTED_BROWSER', {
          message: `Browser speech could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
        }),
      });
    }
  }

  stop(): void {
    this.stopped = true;
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition === null) return;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      // already stopped
    }
  }
}
