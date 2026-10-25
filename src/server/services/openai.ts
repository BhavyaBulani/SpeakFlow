import type { AiJsonMode } from '../config';
import { ApiError } from '../lib/http';
import { logger } from '../lib/logger';

/**
 * Thin, dependency-free client for the two OpenAI surfaces SpeakFlow needs.
 *
 *  - `structuredCompletion` -> Chat Completions with Structured Outputs
 *    (JSON Schema enforced by the provider, then re-validated with Zod).
 *  - `createTranscriptionToken` -> Realtime API ephemeral client secret, so the
 *    browser can open a WebRTC transcription session without ever seeing the
 *    API key.
 *
 * Endpoints and payload shapes were checked against the published OpenAPI
 * specification (`POST /v1/realtime/client_secrets`, `POST /v1/realtime/calls`,
 * events `input_audio_transcription.delta` / `.completed`).
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StructuredCompletionRequest {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  temperature: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Passed to mock providers only; ignored by the real API. */
  variant?: string;
}

export interface StructuredCompletionResult {
  /** Raw JSON text produced by the model. */
  raw: string;
  model: string;
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export interface TranscriptionTokenRequest {
  model: string;
  language: string;
  silenceDurationMs: number;
  ttlSeconds: number;
  signal?: AbortSignal;
}

export interface TranscriptionToken {
  token: string;
  expiresAt: number;
  model: string;
  sampleRate: number;
  /** Absolute URL that accepts a WebRTC SDP offer authenticated with `token`. */
  sdpUrl: string;
}

export interface AiClient {
  /** Which provider actually answered. Reported to the UI as the engine name. */
  readonly id: AiClientId;
  structuredCompletion(request: StructuredCompletionRequest): Promise<StructuredCompletionResult>;
  createTranscriptionToken(request: TranscriptionTokenRequest): Promise<TranscriptionToken>;
}

const REALTIME_SAMPLE_RATE = 24_000;

/** Provider identities. `mock` is never presented as real output. */
export type AiClientId = 'openai' | 'groq' | 'openai-compatible' | 'local' | 'mock';

function buildAbortPair(timeoutMs: number, external?: AbortSignal): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = (): void => controller.abort();
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

export class OpenAiClient implements AiClient {
  readonly id: AiClientId;

  constructor(
    private readonly options: {
      id?: AiClientId;
      apiKey: string;
      baseUrl: string;
      timeoutMs: number;
      /** `json_schema` is enforced by the provider; `json_object` is not. */
      jsonMode?: AiJsonMode;
    },
  ) {
    this.id = options.id ?? 'openai';
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // A local model server (Ollama, LM Studio, llama.cpp) needs no credential,
    // and sending an empty `Bearer ` makes some of them reject the request.
    if (this.options.apiKey !== '') {
      headers.Authorization = `Bearer ${this.options.apiKey}`;
    }
    return headers;
  }

  async structuredCompletion(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletionResult> {
    const startedAt = Date.now();
    const abort = buildAbortPair(this.options.timeoutMs, request.signal);

    const jsonMode = this.options.jsonMode ?? 'json_schema';

    // With `json_schema` the provider enforces the shape. With `json_object`
    // (free-tier hosts) it only guarantees *syntactically* valid JSON, so the
    // schema has to be stated in the prompt instead.
    const system =
      jsonMode === 'json_schema'
        ? request.system
        : `${request.system}\n\nOUTPUT FORMAT: reply with exactly one JSON object and nothing else - no markdown, no code fences, no commentary. It must satisfy this JSON Schema:\n${JSON.stringify(request.schema)}`;

    const body: Record<string, unknown> = {
      model: request.model,
      temperature: request.temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: request.user },
      ] satisfies ChatMessage[],
      response_format:
        jsonMode === 'json_schema'
          ? {
              type: 'json_schema',
              json_schema: {
                name: request.schemaName,
                strict: true,
                schema: request.schema,
              },
            }
          : { type: 'json_object' },
    };
    if (request.maxOutputTokens !== undefined && request.maxOutputTokens > 0) {
      body.max_completion_tokens = request.maxOutputTokens;
    }

    try {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw this.mapHttpError(response.status, detail);
      }

      const payload = (await response.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new ApiError('AI_INVALID_OUTPUT', {
          message: 'The AI returned an empty answer. A safe fallback was used.',
        });
      }

      return {
        raw: content,
        model: payload.model ?? request.model,
        latencyMs: Date.now() - startedAt,
        usage:
          payload.usage === undefined
            ? null
            : {
                promptTokens: payload.usage.prompt_tokens ?? 0,
                completionTokens: payload.usage.completion_tokens ?? 0,
              },
      };
    } catch (error) {
      throw this.mapThrownError(error, abort.didTimeout, request.signal);
    } finally {
      abort.cleanup();
    }
  }

  async createTranscriptionToken(request: TranscriptionTokenRequest): Promise<TranscriptionToken> {
    if (this.id !== 'openai') {
      // Realtime transcription is an OpenAI surface. Anything else would be a lie.
      throw new ApiError('PROVIDER_NOT_CONFIGURED', {
        message:
          'Streaming transcription requires the OpenAI Realtime API (AI_PROVIDER=openai plus OPENAI_API_KEY). The configured reply provider cannot open an audio stream; use Browser speech or the Demo transcript.',
      });
    }

    const abort = buildAbortPair(this.options.timeoutMs, request.signal);

    const sessionConfig = {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
          transcription: {
            model: request.model,
            ...(request.language.length > 0 ? { language: request.language } : {}),
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: request.silenceDurationMs,
          },
        },
      },
      include: ['item.input_audio_transcription.logprobs'],
    };

    try {
      const response = await fetch(`${this.options.baseUrl}/realtime/client_secrets`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: request.ttlSeconds },
          session: sessionConfig,
        }),
        signal: abort.signal,
      });

      if (response.status === 404) {
        // Older accounts may not expose the GA endpoint; fall back to the
        // legacy transcription-sessions endpoint, which returns the same
        // ephemeral key under a nested `client_secret` object.
        return await this.createLegacyTranscriptionToken(request, abort.signal);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw this.mapHttpError(response.status, detail);
      }

      const payload = (await response.json()) as {
        value?: unknown;
        expires_at?: unknown;
      };

      if (typeof payload.value !== 'string' || payload.value.length === 0) {
        throw new ApiError('AI_UPSTREAM_ERROR', {
          message: 'The AI provider did not return a realtime token.',
        });
      }

      return {
        token: payload.value,
        expiresAt:
          typeof payload.expires_at === 'number'
            ? payload.expires_at
            : Math.floor(Date.now() / 1000) + request.ttlSeconds,
        model: request.model,
        sampleRate: REALTIME_SAMPLE_RATE,
        sdpUrl: `${this.options.baseUrl}/realtime/calls`,
      };
    } catch (error) {
      throw this.mapThrownError(error, abort.didTimeout, request.signal);
    } finally {
      abort.cleanup();
    }
  }

  private async createLegacyTranscriptionToken(
    request: TranscriptionTokenRequest,
    signal: AbortSignal,
  ): Promise<TranscriptionToken> {
    logger.warn('openai.realtime.legacy_endpoint', { model: request.model });
    const response = await fetch(`${this.options.baseUrl}/realtime/transcription_sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: request.model,
          ...(request.language.length > 0 ? { language: request.language } : {}),
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: request.silenceDurationMs,
        },
      }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw this.mapHttpError(response.status, detail);
    }

    const payload = (await response.json()) as {
      client_secret?: { value?: unknown; expires_at?: unknown };
    };
    const token = payload.client_secret?.value;
    if (typeof token !== 'string' || token.length === 0) {
      throw new ApiError('AI_UPSTREAM_ERROR', {
        message: 'The AI provider did not return a realtime token.',
      });
    }

    return {
      token,
      expiresAt:
        typeof payload.client_secret?.expires_at === 'number'
          ? payload.client_secret.expires_at
          : Math.floor(Date.now() / 1000) + request.ttlSeconds,
      model: request.model,
      sampleRate: REALTIME_SAMPLE_RATE,
      sdpUrl: `${this.options.baseUrl}/realtime/calls`,
    };
  }

  private mapHttpError(status: number, detail: string): ApiError {
    // Provider detail is logged (truncated) but never returned to the client.
    logger.warn('openai.http_error', { status, detail: detail.slice(0, 300) });

    if (status === 401 || status === 403) {
      return new ApiError('AI_UPSTREAM_ERROR', {
        message:
          'The AI provider rejected the server credentials. Check AI_API_KEY (or OPENAI_API_KEY for OpenAI).',
      });
    }
    if (status === 429) {
      return new ApiError('AI_RATE_LIMITED', {
        message: 'The AI provider is rate limiting requests. Please try again in a moment.',
      });
    }
    if (status === 404) {
      return new ApiError('AI_UPSTREAM_ERROR', {
        message: 'The configured AI model is not available on this account.',
      });
    }
    if (status >= 500) {
      return new ApiError('AI_UPSTREAM_ERROR');
    }
    return new ApiError('AI_UPSTREAM_ERROR', {
      message: 'The AI provider rejected the request.',
    });
  }

  private mapThrownError(
    error: unknown,
    didTimeout: () => boolean,
    externalSignal?: AbortSignal,
  ): ApiError {
    if (error instanceof ApiError) return error;

    if (externalSignal?.aborted === true) {
      return new ApiError('REQUEST_ABORTED', { message: 'Request cancelled.' });
    }
    if (didTimeout()) {
      return new ApiError('AI_TIMEOUT');
    }
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return new ApiError('AI_TIMEOUT');
    }
    logger.error('openai.fetch_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return new ApiError('AI_UPSTREAM_ERROR', {
      message: 'Could not reach the AI provider. Check the server network connection.',
    });
  }
}

/**
 * Deterministic stand-in used when `MOCK_AI=1` (tests, and UI work without a
 * key). It returns JSON through the exact same parse+validate path as the real
 * client, and every reply it produces is reported to the UI as engine
 * `mock` so it can never be mistaken for a real model answer.
 */
export class MockAiClient implements AiClient {
  readonly id = 'mock' as const;
  constructor(private readonly config: { failMode?: 'timeout' | 'invalid' | 'none' } = {}) {}

  async structuredCompletion(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletionResult> {
    await new Promise((resolve) => setTimeout(resolve, 30));

    if (this.config.failMode === 'timeout') {
      throw new ApiError('AI_TIMEOUT');
    }
    if (this.config.failMode === 'invalid') {
      return {
        raw: JSON.stringify({ unexpected: true }),
        model: 'mock-invalid',
        latencyMs: 30,
        usage: null,
      };
    }

    if (request.schemaName === 'speakflow_translation') {
      return {
        raw: JSON.stringify({
          english: 'The issue is fixed. Could you please check it again?',
          alternatives: ['I have fixed the issue - please have another look.'],
          notes: null,
          tone: 'professional',
        }),
        model: 'mock-translator',
        latencyMs: 30,
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    }

    const provisional = request.variant === 'provisional';
    return {
      raw: JSON.stringify({
        suggested_reply: provisional
          ? 'Let me check that and come back to you.'
          : "I'll check what's causing the delay and update you shortly.",
        alternative_reply: provisional ? null : 'Let me look into the delay and confirm with you.',
        needs_clarification: false,
        facts_to_verify: ['the actual cause of the delay'],
        confidence: provisional ? 'low' : 'medium',
        intent: 'question',
      }),
      model: 'mock-reply',
      latencyMs: 30,
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }

  async createTranscriptionToken(request: TranscriptionTokenRequest): Promise<TranscriptionToken> {
    void request;
    // Deliberate: the mock provider never pretends a real audio session exists.
    throw new ApiError('PROVIDER_NOT_CONFIGURED', {
      message:
        'Mock mode cannot open a real streaming transcription session. Add OPENAI_API_KEY, or use Browser speech / Demo transcript.',
    });
  }
}

/**
 * Used when the server has no usable credentials. Every call fails loudly with
 * a 503 and an actionable message - SpeakFlow never fakes a working AI.
 */
export class UnconfiguredAiClient implements AiClient {
  readonly id = 'openai' as const;
  async structuredCompletion(request: StructuredCompletionRequest): Promise<StructuredCompletionResult> {
    void request;
    throw new ApiError('PROVIDER_NOT_CONFIGURED');
  }

  async createTranscriptionToken(request: TranscriptionTokenRequest): Promise<TranscriptionToken> {
    void request;
    throw new ApiError('PROVIDER_NOT_CONFIGURED');
  }
}
