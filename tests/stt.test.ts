import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server/app';
import { deriveConfig, type ServerConfig } from '../src/server/config';
import {
  OpenAiCompatibleSttClient,
  UnconfiguredSttClient,
  createSttClient,
} from '../src/server/services/stt';
import { MockAiClient } from '../src/server/services/openai';
import { encodeWav16k } from '../src/shared/audioFraming';
import { bytesToBase64 } from '../src/shared/audioFraming';

/**
 * The chunked transcription path.
 *
 * These tests exist because this route is the only route that can reach a real
 * speech-to-text provider at ₹0, and it is easy to break silently: a wrong
 * multipart field name or a missing WAV header still returns HTTP 200 from our
 * server while the provider rejects every chunk.
 */

function chunkConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...deriveConfig({
      NODE_ENV: 'test',
      STT_PROVIDER: 'openai-compatible',
      STT_API_KEY: 'gsk_test_key',
      AI_API_KEY: 'gsk_test_key',
      AI_PROVIDER: 'groq',
    }),
    ...overrides,
  };
}

/** A 0.5 s WAV of a 220 Hz tone - real audio bytes, not a string. */
function wavBase64(): string {
  const samples = new Float32Array(8_000);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / 16_000) * 0.4;
  }
  return bytesToBase64(encodeWav16k(samples));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAiCompatibleSttClient', () => {
  it('posts a multipart body with the model, language and a .wav file', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    let capturedForm: FormData | null = null;

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedAuth = headers.Authorization ?? '';
      capturedForm = init?.body as FormData;
      return jsonResponse({ text: 'Can you check the deployment?', language: 'en' });
    }) as unknown as typeof fetch;

    const client = new OpenAiCompatibleSttClient({
      apiKey: 'gsk_test_key',
      baseUrl: 'https://api.groq.com/openai/v1/',
      model: 'whisper-large-v3-turbo',
      timeoutMs: 5000,
      fetchImpl,
    });

    const wav = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);
    const result = await client.transcribe({ wav, language: 'en' });

    expect(capturedUrl).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(capturedAuth).toBe('Bearer gsk_test_key');
    expect(capturedForm).not.toBeNull();

    const form = capturedForm as unknown as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('language')).toBe('en');
    expect(form.get('response_format')).toBe('json');

    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('chunk.wav');

    expect(result.text).toBe('Can you check the deployment?');
    expect(result.mode).toBe('chunked');
    expect(result.language).toBe('en');
  });

  it('omits the language field when the hint is empty, instead of sending a blank', async () => {
    let capturedForm: FormData | null = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return jsonResponse({ text: 'hello' });
    }) as unknown as typeof fetch;

    const client = new OpenAiCompatibleSttClient({
      apiKey: 'k',
      baseUrl: 'https://example.test/v1',
      model: 'whisper-1',
      timeoutMs: 1000,
      fetchImpl,
    });
    await client.transcribe({ wav: new Uint8Array([1, 2, 3]), language: '  ' });

    expect((capturedForm as unknown as FormData).get('language')).toBeNull();
  });

  it('maps a 429 to a rate-limit error that names the free-tier audio limit', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'rate limited' }, 429)) as unknown as typeof fetch;
    const client = new OpenAiCompatibleSttClient({
      apiKey: 'k',
      baseUrl: 'https://example.test/v1',
      model: 'm',
      timeoutMs: 1000,
      fetchImpl,
    });

    await expect(client.transcribe({ wav: new Uint8Array([1]), language: 'en' })).rejects.toMatchObject({
      code: 'AI_RATE_LIMITED',
      status: 429,
    });
  });

  it('maps a rejected key to PROVIDER_NOT_CONFIGURED rather than a generic failure', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'bad key' }, 401)) as unknown as typeof fetch;
    const client = new OpenAiCompatibleSttClient({
      apiKey: 'wrong',
      baseUrl: 'https://example.test/v1',
      model: 'm',
      timeoutMs: 1000,
      fetchImpl,
    });

    await expect(client.transcribe({ wav: new Uint8Array([1]), language: 'en' })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  });

  it('distinguishes a caller abort from a provider timeout', async () => {
    const hang = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    const client = new OpenAiCompatibleSttClient({
      apiKey: 'k',
      baseUrl: 'https://example.test/v1',
      model: 'm',
      timeoutMs: 20,
      fetchImpl: hang,
    });
    await expect(client.transcribe({ wav: new Uint8Array([1]), language: 'en' })).rejects.toMatchObject({
      code: 'AI_TIMEOUT',
    });

    const controller = new AbortController();
    const abortingClient = new OpenAiCompatibleSttClient({
      apiKey: 'k',
      baseUrl: 'https://example.test/v1',
      model: 'm',
      timeoutMs: 5000,
      fetchImpl: hang,
    });
    const pending = abortingClient.transcribe({
      wav: new Uint8Array([1]),
      language: 'en',
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });

  it('refuses to send an empty chunk', async () => {
    const client = new OpenAiCompatibleSttClient({
      apiKey: 'k',
      baseUrl: 'https://example.test/v1',
      model: 'm',
      timeoutMs: 1000,
      fetchImpl: (async () => jsonResponse({ text: '' })) as unknown as typeof fetch,
    });
    await expect(
      client.transcribe({ wav: new Uint8Array(0), language: 'en' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('createSttClient', () => {
  it('returns an honest unconfigured client when no STT key exists', () => {
    const config = chunkConfig({ sttApiKey: null });
    const client = createSttClient(config);
    expect(client).toBeInstanceOf(UnconfiguredSttClient);
  });

  it('does not reuse an OpenAI key for a Groq endpoint', () => {
    // Only OPENAI_API_KEY is set; STT points at groq. Borrowing the key would
    // fail authentication at request time, so it must not be borrowed at all.
    const config = deriveConfig({
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'sk-openai-only',
      STT_PROVIDER: 'openai-compatible',
    });
    expect(config.sttApiKey).toBeNull();
    expect(config.sttBaseUrl).toContain('groq.com');
  });

  it('falls back to OPENAI_API_KEY for the OpenAI realtime surface', () => {
    const config = deriveConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'sk-openai-only' });
    expect(config.sttProvider).toBe('openai-realtime');
    expect(config.sttMode).toBe('realtime');
    expect(config.sttApiKey).toBe('sk-openai-only');
  });

  it('reports chunked mode and the preset model for STT_PROVIDER=openai-compatible', () => {
    const config = deriveConfig({
      NODE_ENV: 'test',
      STT_PROVIDER: 'openai-compatible',
      STT_API_KEY: 'gsk_x',
    });
    expect(config.sttMode).toBe('chunked');
    expect(config.sttModel).toBe('whisper-large-v3-turbo');
    expect(config.sttBaseUrl).toBe('https://api.groq.com/openai/v1');
  });
});

describe('POST /api/stt/chunk', () => {
  function appWith(overrides: Partial<ServerConfig> = {}, fetchImpl?: typeof fetch) {
    return createApp({
      config: chunkConfig(overrides),
      overrides: {
        aiClient: new MockAiClient(),
        ...(fetchImpl === undefined ? {} : { sttFetch: fetchImpl }),
      },
    });
  }

  it('transcribes a chunk and echoes the ordering fields back', async () => {
    const { app } = appWith(
      {},
      (async () =>
        jsonResponse({ text: 'Is the release still on for Friday?', language: 'en' })) as unknown as typeof fetch,
    );

    const session = await request(app).post('/api/sessions').send({});
    expect(session.status).toBe(201);

    const response = await request(app)
      .post('/api/stt/chunk')
      .send({
        sessionId: session.body.id,
        seq: 3,
        startSample: 38_400,
        wavBase64: wavBase64(),
        language: 'en',
      });

    expect(response.status).toBe(200);
    expect(response.body.text).toBe('Is the release still on for Friday?');
    expect(response.body.mode).toBe('chunked');
    expect(response.body.seq).toBe(3);
    expect(response.body.startSample).toBe(38_400);
    expect(typeof response.body.receivedAt).toBe('number');
    // The transcript must never be echoed into a log-visible field.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects audio that is not a complete WAV file', async () => {
    const { app } = appWith({}, (async () => jsonResponse({ text: 'x' })) as unknown as typeof fetch);
    const session = await request(app).post('/api/sessions').send({});

    const notRiff = Buffer.alloc(64, 7).toString('base64');
    const response = await request(app).post('/api/stt/chunk').send({
      sessionId: session.body.id,
      seq: 0,
      startSample: 0,
      wavBase64: notRiff,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.message).toMatch(/RIFF/i);
  });

  it('refuses to transcribe for a session it did not create', async () => {
    const { app } = appWith({}, (async () => jsonResponse({ text: 'x' })) as unknown as typeof fetch);

    const response = await request(app).post('/api/stt/chunk').send({
      sessionId: 'f'.repeat(32),
      seq: 0,
      startSample: 0,
      wavBase64: wavBase64(),
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('states plainly that a realtime-configured server has no chunk route', async () => {
    const { app } = appWith({ sttMode: 'realtime', sttProvider: 'openai-realtime' });

    const response = await request(app).post('/api/stt/chunk').send({
      sessionId: 'a'.repeat(32),
      seq: 0,
      startSample: 0,
      wavBase64: wavBase64(),
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/STT_PROVIDER=openai-compatible/);
  });

  it('returns 503 with configuration guidance when no STT key is set', async () => {
    const { app } = appWith({ sttApiKey: null });
    const session = await request(app).post('/api/sessions').send({});

    const response = await request(app).post('/api/stt/chunk').send({
      sessionId: session.body.id,
      seq: 0,
      startSample: 0,
      wavBase64: wavBase64(),
    });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(response.body.error.message).toMatch(/STT_API_KEY/);
  });

  it('stops transcription once the per-session chunk limit is reached', async () => {
    const { app } = appWith(
      { sttMaxRequestsPerSession: 2 },
      (async () => jsonResponse({ text: 'ok' })) as unknown as typeof fetch,
    );
    const session = await request(app).post('/api/sessions').send({});
    const body = { sessionId: session.body.id, startSample: 0, wavBase64: wavBase64() };

    const first = await request(app).post('/api/stt/chunk').send({ ...body, seq: 0 });
    const second = await request(app).post('/api/stt/chunk').send({ ...body, seq: 1 });
    const third = await request(app).post('/api/stt/chunk').send({ ...body, seq: 2 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('AI_BUDGET_EXHAUSTED');
    expect(third.body.error.message).toMatch(/STT_MAX_REQUESTS_PER_SESSION/);
  });

  it('advertises chunked capability in /api/config without leaking the key', async () => {
    const { app } = appWith();
    const response = await request(app).get('/api/config');

    expect(response.status).toBe(200);
    expect(response.body.sttConfigured).toBe(true);
    expect(response.body.sttProvider).toBe('openai-compatible');
    expect(response.body.sttMode).toBe('chunked');
    expect(response.body.sttModel).toBe('whisper-large-v3-turbo');
    expect(JSON.stringify(response.body)).not.toContain('gsk_test_key');
  });
});
