import { translateResultSchema } from '../../shared/schemas';
import type { ApiErrorCode } from '../../shared/errors';
import { API_ERROR_MESSAGES, isApiErrorBody } from '../../shared/errors';
import { replyResultSchema } from '../../shared/schemas';
import type {
  AppConfig,
  RealtimeTokenResponse,
  RefineDirective,
  ReplyIntent,
  ReplyResult,
  ReplyStage,
  ReplyTone,
  SessionInfo,
  TranslateResult,
  VocabularyItem,
} from '../../shared/types';

/**
 * Typed browser client for the SpeakFlow API.
 *
 * Two jobs it never skips:
 *  1. Send the workspace access token when one is configured.
 *  2. Validate every AI response against the shared schema before the UI sees
 *     it, so a malformed reply can never land in the script panel mid-call.
 */

export class ApiRequestError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string | null;

  constructor(code: ApiErrorCode, message: string, status: number, requestId: string | null = null) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }

  get isAbort(): boolean {
    return this.code === 'REQUEST_ABORTED';
  }
}

export interface ApiClientOptions {
  /** Defaults to same-origin '/api'. */
  baseUrl?: string;
  accessToken?: string | null;
  clientId: string;
}

export interface GenerateReplyInput {
  sessionId: string;
  stage: ReplyStage;
  version: number;
  utterance: string;
  recentFinals: string[];
  tone: ReplyTone;
  userContext: string;
  utteranceUnfinished: boolean;
  replyIntent?: ReplyIntent | null;
  refine?: RefineDirective | null;
  previousReply?: string | null;
  signal?: AbortSignal;
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? '/api').replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Client-Id': this.options.clientId,
      ...extra,
    };
    const token = this.options.accessToken;
    if (typeof token === 'string' && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { parse?: (value: unknown) => T } = {},
  ): Promise<T> {
    const { parse, ...rest } = init;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...rest,
        headers: this.headers((rest.headers as Record<string, string>) ?? {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiRequestError('REQUEST_ABORTED', 'Request cancelled.', 0);
      }
      throw new ApiRequestError(
        'INTERNAL',
        'Could not reach the SpeakFlow server. Check that it is running.',
        0,
      );
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const requestId = response.headers.get('X-Request-Id');
      if (isApiErrorBody(payload)) {
        throw new ApiRequestError(payload.error.code, payload.error.message, response.status, requestId);
      }
      throw new ApiRequestError(
        'INTERNAL',
        `The server returned an unexpected response (${response.status}).`,
        response.status,
        requestId,
      );
    }

    if (parse !== undefined) return parse(payload);
    return payload as T;
  }

  async getConfig(): Promise<AppConfig> {
    return this.request<AppConfig>('/config', { method: 'GET', headers: {} });
  }

  async health(): Promise<{ status: string; aiConfigured: boolean; mockAi: boolean }> {
    return this.request('/health', { method: 'GET', headers: {} });
  }

  async createSession(): Promise<SessionInfo> {
    return this.request<SessionInfo>('/sessions', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }

  async generateReply(input: GenerateReplyInput): Promise<ReplyResult> {
    const payload = {
      stage: input.stage,
      version: input.version,
      utterance: input.utterance,
      recentFinals: input.recentFinals,
      tone: input.tone,
      userContext: input.userContext,
      utteranceUnfinished: input.utteranceUnfinished,
      replyIntent: input.replyIntent ?? null,
      refine: input.refine ?? null,
      previousReply: input.previousReply ?? null,
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(input.sessionId)}/reply`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiRequestError('REQUEST_ABORTED', 'Superseded by newer speech.', 0);
      }
      throw new ApiRequestError(
        'INTERNAL',
        'Could not reach the SpeakFlow server. Check that it is running.',
        0,
      );
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (isApiErrorBody(body)) {
        throw new ApiRequestError(
          body.error.code,
          body.error.message,
          response.status,
          response.headers.get('X-Request-Id'),
        );
      }
      throw new ApiRequestError('INTERNAL', 'The reply request failed.', response.status);
    }

    const raw: unknown = await response.json();
    const parsed = replyResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiRequestError(
        'AI_INVALID_OUTPUT',
        'The reply came back in an unexpected shape, so it was not shown.',
        response.status,
      );
    }
    return parsed.data;
  }

  async translate(
    input: { text: string; targetTone: ReplyTone; sourceLanguage: 'auto' | 'hi' | 'hinglish' | 'en' },
    signal?: AbortSignal,
  ): Promise<TranslateResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/translate`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiRequestError('REQUEST_ABORTED', 'Translation cancelled.', 0);
      }
      throw new ApiRequestError('INTERNAL', 'Could not reach the SpeakFlow server.', 0);
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (isApiErrorBody(body)) {
        throw new ApiRequestError(body.error.code, body.error.message, response.status);
      }
      throw new ApiRequestError('INTERNAL', 'The translation request failed.', response.status);
    }

    const raw: unknown = await response.json();
    const parsed = translateResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiRequestError(
        'AI_INVALID_OUTPUT',
        'The translation came back in an unexpected shape.',
        response.status,
      );
    }
    return parsed.data;
  }

  async createRealtimeToken(): Promise<RealtimeTokenResponse> {
    const response = await fetch(`${this.baseUrl}/realtime/token`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (isApiErrorBody(body)) {
        throw new ApiRequestError(body.error.code, body.error.message, response.status);
      }
      throw new ApiRequestError('INTERNAL', 'Could not get a streaming token.', response.status);
    }

    const payload = (await response.json()) as RealtimeTokenResponse;
    if (typeof payload.token !== 'string' || payload.token.length === 0) {
      throw new ApiRequestError('TOKEN_FAILED' as ApiErrorCode, 'The streaming token was empty.', 500);
    }
    return payload;
  }

  /**
   * Send one audio chunk for recognition.
   *
   * Deliberately separate from `request()`: the payload is large (base64 audio),
   * and the response shape is deliberately narrow so nothing but text can leak
   * back into the transcript UI.
   */
  async transcribeChunk(input: {
    sessionId: string;
    seq: number;
    startSample: number;
    wavBase64: string;
  }): Promise<{ text: string; mode: string }> {
    const response = await fetch(`${this.baseUrl}/stt/chunk`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (isApiErrorBody(body)) {
        throw new ApiRequestError(
          body.error.code,
          body.error.message,
          response.status,
          response.headers.get('X-Request-Id'),
        );
      }
      throw new ApiRequestError('INTERNAL', 'The transcription request failed.', response.status);
    }

    const payload = (await response.json()) as { text?: unknown; mode?: unknown };
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      mode: typeof payload.mode === 'string' ? payload.mode : 'chunked',
    };
  }

  async listVocabulary(): Promise<VocabularyItem[]> {
    const payload = await this.request<{ items: VocabularyItem[] }>('/vocabulary', {
      method: 'GET',
      headers: {},
    });
    return payload.items;
  }

  async saveVocabulary(input: {
    term: string;
    meaningEn: string;
    meaningHi: string | null;
    example: string | null;
  }): Promise<VocabularyItem> {
    return this.request<VocabularyItem>('/vocabulary', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async deleteVocabulary(id: string): Promise<void> {
    await this.request<void>(`/vocabulary/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

export function describeApiError(error: unknown): { message: string; code: ApiErrorCode | 'NETWORK' } {
  if (error instanceof ApiRequestError) {
    return {
      message: error.message || API_ERROR_MESSAGES[error.code] || 'Something went wrong.',
      code: error.code,
    };
  }
  if (error instanceof Error) return { message: error.message, code: 'INTERNAL' };
  return { message: 'Something went wrong.', code: 'INTERNAL' };
}
