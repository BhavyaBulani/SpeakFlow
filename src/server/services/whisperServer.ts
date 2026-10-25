import { ApiError } from '../lib/http';
import { logger } from '../lib/logger';
import type { SttClient, TranscribeAudioInput, TranscribeAudioResult } from './stt';

/**
 * Local speech-to-text against `whisper-server.exe` (whisper.cpp server mode).
 *
 * Why this exists next to the CLI client: `whisper-cli` is one process per
 * chunk, so every chunk pays process startup plus model load. `whisper-server`
 * keeps the model resident and accepts the WAV over HTTP, which removes that
 * per-chunk cost entirely. Measured difference is in docs/BENCHMARKS.md.
 *
 * Endpoint shape verified against the real binary on this machine
 * (`scripts/probe-whisper-server.mjs`), not guessed:
 *   POST {base}/inference   multipart form-data, field `file` = WAV
 *   -> 200 {"text":" Can you explain why ...?\n"}
 * This build does NOT expose the newer `/v1/audio/transcriptions` route (404).
 *
 * The server is a long-running process, so SpeakFlow never starts it: a process
 * spawned by the app cannot outlive the request on this machine, and silently
 * launching a background daemon is not something a web app should do. The
 * operator starts it (see docs/LOCAL_STT.md) and this client connects to it.
 */

export interface WhisperServerOptions {
  /** Base URL of an already-running whisper-server, e.g. http://127.0.0.1:8080 */
  serverUrl: string;
  timeoutMs: number;
  /** '' lets the model detect. */
  language?: string;
  /** Shown in /api/config; basename of the ggml model. */
  modelName: string;
  /** Injected in tests so no real server is needed. */
  fetchImpl?: typeof fetch;
}

/** Pull `text` out of the server's JSON body without trusting its shape. */
export function parseWhisperServerBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && 'text' in parsed) {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text === 'string') return text.replace(/\s+/g, ' ').trim();
    }
    // Some builds return { segments: [...] }; reconstruct from those rather
    // than reporting silence, but only from real fields.
    if (parsed !== null && typeof parsed === 'object' && 'segments' in parsed) {
      const segments = (parsed as { segments?: unknown }).segments;
      if (Array.isArray(segments)) {
        const joined = segments
          .map((segment) =>
            segment !== null && typeof segment === 'object' && typeof (segment as { text?: unknown }).text === 'string'
              ? ((segment as { text: string }).text ?? '')
              : '',
          )
          .join(' ');
        return joined.replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  } catch {
    // Not JSON: a plain-text body is a valid transcript in some builds.
    return trimmed.replace(/\s+/g, ' ').trim();
  }
}

export class WhisperServerSttClient implements SttClient {
  readonly id = 'whisper-cpp' as const;
  readonly mode = 'chunked' as const;
  readonly model: string;

  private readonly options: WhisperServerOptions;
  private readonly baseUrl: string;

  constructor(options: WhisperServerOptions) {
    this.options = options;
    this.model = options.modelName;
    this.baseUrl = options.serverUrl.replace(/\/+$/, '');
  }

  async transcribe(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
    if (input.wav.length === 0) {
      throw new ApiError('VALIDATION_FAILED', { message: 'No audio was received.' });
    }

    const startedAt = Date.now();
    const doFetch = this.options.fetchImpl ?? fetch;

    const form = new FormData();
    // A copy is required: the buffer is a view over pooled memory.
    form.append('file', new Blob([new Uint8Array(input.wav)], { type: 'audio/wav' }), 'chunk.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const language = this.options.language?.trim() ?? '';
    if (language.length > 0) form.append('language', language);

    let response: Response;
    try {
      response = await doFetch(`${this.baseUrl}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : String(error);
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ApiError('AI_TIMEOUT', { message: 'Local transcription took too long.' });
      }
      // Connection refused / DNS failure is the common case: the operator has
      // not started the server. Say so instead of blaming the model.
      logger.warn('stt.whisper_server_unreachable', { url: this.baseUrl, detail: message.slice(0, 120) });
      throw new ApiError('PROVIDER_NOT_CONFIGURED', {
        message:
          `Could not reach the local recogniser at ${this.baseUrl}. ` +
          'Start whisper-server (see docs/LOCAL_STT.md) or set WHISPER_CPP_SERVER_URL.',
      });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.warn('stt.whisper_server_error', { status: response.status, detail: detail.slice(0, 120) });
      if (response.status === 429) {
        throw new ApiError('AI_RATE_LIMITED', { message: 'The local recogniser is busy. Try again shortly.' });
      }
      if (response.status === 401 || response.status === 403) {
        throw new ApiError('PROVIDER_NOT_CONFIGURED', {
          message: 'The local recogniser rejected the request. Check WHISPER_CPP_SERVER_URL.',
        });
      }
      throw new ApiError('AI_UPSTREAM_ERROR', {
        message: 'The local recogniser could not process that audio.',
      });
    }

    const body = await response.text();
    const text = parseWhisperServerBody(body);

    return {
      text,
      // whisper.cpp does not report a detected language for .en models, and one
      // is not invented here.
      language: null,
      mode: 'chunked',
      providerMs: Date.now() - startedAt,
      model: this.model,
    };
  }
}
