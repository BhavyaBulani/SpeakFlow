import { ApiError } from '../lib/http';
import { logger } from '../lib/logger';
import type { ServerConfig } from '../config';

/**
 * Speech-to-text provider adapter.
 *
 * Two transports exist and they are NOT interchangeable, so the difference is
 * modelled explicitly rather than hidden behind one "transcribe" method:
 *
 *  - `realtime` streams audio and the provider emits words while the speaker is
 *    still talking (OpenAI Realtime over WebRTC). The browser talks to the
 *    provider directly; this server only mints a short-lived token.
 *
 *  - `chunked` posts short self-contained WAV chunks to the ordinary
 *    `/audio/transcriptions` endpoint. The provider returns text per chunk, so
 *    the first transcript arrives only after the chunk closes (typically
 *    1.5-3 s with the defaults). This is what makes a free tier usable at all.
 *
 * Every response carries `mode` so the UI can describe what the user is
 * actually getting instead of implying streaming.
 */

export interface TranscribeAudioInput {
  /** Self-contained 16 kHz mono PCM WAV (ArrayBuffer-backed so Blob accepts it). */
  wav: Uint8Array<ArrayBuffer>;
  /** BCP-47-ish language hint; '' lets the provider detect. */
  language: string;
  signal?: AbortSignal;
}

export interface TranscribeAudioResult {
  text: string;
  /** Present only when the provider genuinely returns it. */
  language: string | null;
  mode: 'chunked';
  /** Provider-measured processing time, when reported. */
  providerMs: number | null;
  model: string;
}

export interface SttClient {
  readonly id: 'openai-realtime' | 'openai-compatible' | 'whisper-cpp';
  readonly mode: 'realtime' | 'chunked';
  readonly model: string;
  transcribe(input: TranscribeAudioInput): Promise<TranscribeAudioResult>;
}

interface TranscriptionApiResponse {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
}

/** True when the chunked HTTP route has everything it needs. */
export function isConfiguredForChunkedStt(config: ServerConfig): boolean {
  return config.sttMode === 'chunked' && config.sttApiKey !== null;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const cleaned = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const globalBuffer = (
    globalThis as {
      Buffer?: { from(input: string, enc: string): Uint8Array };
    }
  ).Buffer;
  if (globalBuffer !== undefined) {
    return new Uint8Array(globalBuffer.from(cleaned, 'base64'));
  }
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Map a provider HTTP status onto a code the UI already understands. */
function statusToApiError(status: number, detail: string): ApiError {
  const truncated = detail.slice(0, 300);
  logger.warn('stt.http_error', { status, detail: truncated });

  if (status === 401 || status === 403) {
    return new ApiError('PROVIDER_NOT_CONFIGURED', {
      status: 503,
      message:
        'The transcription provider rejected the API key. Check STT_API_KEY on the server.',
    });
  }
  if (status === 429) {
    return new ApiError('AI_RATE_LIMITED', {
      status: 429,
      message:
        'The transcription provider is rate limiting us. Free tiers have a per-minute audio limit, so wait a few seconds.',
    });
  }
  if (status === 413) {
    return new ApiError('PAYLOAD_TOO_LARGE', {
      message: 'That audio chunk was too large for the transcription provider. Try a shorter STT_CHUNK_MS.',
    });
  }
  if (status >= 500) {
    return new ApiError('AI_UPSTREAM_ERROR', {
      message: 'The transcription provider is having trouble. SpeakFlow will keep trying.',
    });
  }
  return new ApiError('AI_UPSTREAM_ERROR', {
    message: 'The transcription provider could not process that audio.',
  });
}

/**
 * Chunked STT over an OpenAI-compatible `/audio/transcriptions` endpoint.
 *
 * `fetchImpl` is injected so tests can assert the exact multipart body without
 * a network, and so a future provider can be dropped in without touching the
 * route or the orchestrator.
 */
export class OpenAiCompatibleSttClient implements SttClient {
  readonly id = 'openai-compatible' as const;
  readonly mode = 'chunked' as const;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
    if (input.wav.length === 0) {
      throw new ApiError('VALIDATION_FAILED', { message: 'No audio was received.' });
    }

    const form = new FormData();
    // The provider only needs a filename with a .wav extension to pick the
    // decoder; the bytes themselves are a complete WAV file per chunk.
    form.append('file', new Blob([input.wav], { type: 'audio/wav' }), 'chunk.wav');
    form.append('model', this.model);
    form.append('response_format', 'json');
    if (input.language.trim().length > 0) form.append('language', input.language.trim());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw statusToApiError(response.status, detail);
      }

      const payload = (await response.json()) as TranscriptionApiResponse;
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';

      return {
        text,
        language: typeof payload.language === 'string' ? payload.language : null,
        mode: 'chunked',
        providerMs: Date.now() - startedAt,
        model: this.model,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        // Distinguish "the user moved on" from "the provider hung".
        if (input.signal?.aborted === true) {
          throw new ApiError('REQUEST_ABORTED');
        }
        throw new ApiError('AI_TIMEOUT', {
          message: 'The transcription provider took too long to answer.',
        });
      }
      throw new ApiError('AI_UPSTREAM_ERROR', {
        message: 'Could not reach the transcription provider.',
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Used when no key is present. Returns a 503 with an actionable message rather
 * than pretending to transcribe, which is the whole point of the adapter.
 */
export class UnconfiguredSttClient implements SttClient {
  readonly id = 'openai-compatible' as const;  readonly mode = 'chunked' as const;
  readonly model = 'none';

  async transcribe(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
    void input;
    throw new ApiError('PROVIDER_NOT_CONFIGURED', {
      message:
        'Chunked transcription needs STT_API_KEY (or GROQ_API_KEY) on the server. See docs/STT_PROVIDERS.md.',
    });
  }
}

export function createSttClient(
  config: ServerConfig,
  options: { fetchImpl?: typeof fetch } = {},
): SttClient {
  if (config.sttApiKey === null) return new UnconfiguredSttClient();
  return new OpenAiCompatibleSttClient({
    apiKey: config.sttApiKey,
    baseUrl: config.sttBaseUrl,
    model: config.sttModel,
    timeoutMs: config.aiRequestTimeoutMs,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

export { base64ToBytes };
