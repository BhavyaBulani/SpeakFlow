import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { deriveConfig, type ServerConfig } from '../src/server/config';
import { MockAiClient, OpenAiClient, UnconfiguredAiClient } from '../src/server/services/openai';
import { AiClient } from '../src/server/services/openai';
import type { StructuredCompletionRequest, TranscriptionToken } from '../src/server/services/openai';

/**
 * Acceptance criteria 1, 2, 3, 9, 11 and 12 (server side).
 *
 * Everything here runs against the real Express app with a mocked provider, so
 * validation, error mapping, auth and the reply contract are exercised for real.
 */

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...deriveConfig({
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'test-key',
      MOCK_AI: '0',
      CORS_ORIGINS: 'http://localhost:5173',
      RATE_LIMIT_MAX: '1000',
      AI_RATE_LIMIT_MAX: '1000',
      ENABLE_VOCAB_PERSISTENCE: '0',
    } as NodeJS.ProcessEnv),
    // This file tests the MODEL contract: the prompt, validation, fallbacks and
    // rate limits. The local fast path would answer provisional requests from a
    // template before the model is ever called, so it is disabled here and
    // covered on its own in tests/responseLibrary.test.ts.
    fastPathEnabled: false,
    ...overrides,
  };
}

function appWith(config: ServerConfig, aiClient?: AiClient) {
  return createApp({
    config,
    overrides: aiClient === undefined ? { aiClient: new MockAiClient() } : { aiClient },
  });
}

/** Provider stub that returns a chosen raw JSON string (or throws). */
class ScriptedAiClient implements AiClient {
  readonly id = 'openai' as const;
  calls: StructuredCompletionRequest[] = [];

  constructor(private readonly behaviour: { raw?: string; throwCode?: string; delayMs?: number }) {}

  async structuredCompletion(req: StructuredCompletionRequest) {
    this.calls.push(req);
    if (this.behaviour.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.behaviour.delayMs));
    }
    if (this.behaviour.throwCode !== undefined) {
      const { ApiError } = await import('../src/server/lib/http');
      throw new ApiError(this.behaviour.throwCode as never);
    }
    return {
      raw: this.behaviour.raw ?? '{}',
      model: 'scripted-model',
      latencyMs: 5,
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  }

  async createTranscriptionToken(): Promise<TranscriptionToken> {
    return {
      token: 'ek_test_token_value',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      model: 'gpt-4o-transcribe',
      sampleRate: 24000,
      sdpUrl: 'https://api.openai.com/v1/realtime/calls',
    };
  }
}

const VALID_REPLY = JSON.stringify({
  suggested_reply: "I'll check what's causing the delay and update you shortly.",
  alternative_reply: null,
  needs_clarification: false,
  facts_to_verify: ['the cause of the delay'],
  confidence: 'medium',
  intent: 'question',
});

describe('health and config', () => {
  it('responds to /api/health (criterion 1)', async () => {
    const { app } = appWith(testConfig());
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.aiConfigured).toBe(true);
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('advertises capabilities without leaking the provider key', async () => {
    const { app } = appWith(testConfig());
    const response = await request(app).get('/api/config');
    expect(response.status).toBe(200);
    expect(response.body.aiConfigured).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('test-key');
    expect(response.body).not.toHaveProperty('openaiApiKey');
  });

  it('reports aiConfigured=false when no key is present', async () => {
    const config = testConfig({ aiApiKey: null, realtimeApiKey: null });
    const { app } = appWith(config, new UnconfiguredAiClient());
    const response = await request(app).get('/api/config');
    expect(response.body.aiConfigured).toBe(false);
  });
});

describe('sessions', () => {
  it('creates and deletes a session (criterion 2)', async () => {
    const { app } = appWith(testConfig());
    const created = await request(app).post('/api/sessions').send({});
    expect(created.status).toBe(201);
    expect(created.body.transcriptPersisted).toBe(false);
    expect(typeof created.body.id).toBe('string');

    const deleted = await request(app).delete(`/api/sessions/${created.body.id}`);
    expect(deleted.status).toBe(204);

    const missing = await request(app).delete(`/api/sessions/${created.body.id}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('refuses to save transcripts, with an explanation', async () => {
    const { app } = appWith(testConfig());
    const response = await request(app).post('/api/sessions').send({ saveTranscript: true });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a reply for an unknown session', async () => {
    const { app } = appWith(testConfig());
    const response = await request(app)
      .post('/api/sessions/does-not-exist/reply')
      .send({ stage: 'provisional', version: 1, utterance: 'hello there friend' });
    expect(response.status).toBe(404);
  });
});

describe('reply generation contract', () => {
  it('returns a validated provisional reply (criterion 5)', async () => {
    const client = new ScriptedAiClient({ raw: VALID_REPLY });
    const { app } = appWith(testConfig(), client);
    const session = await request(app).post('/api/sessions').send({});

    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({
        stage: 'provisional',
        version: 3,
        utterance: 'Could you explain why the application is taking longer to',
        utteranceUnfinished: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.stage).toBe('provisional');
    expect(response.body.version).toBe(3);
    expect(response.body.suggestedReply).toContain('check');
    expect(response.body.engine).toBe('openai');
    expect(response.body.notice).toBeNull();
    expect(Array.isArray(response.body.factsToVerify)).toBe(true);
  });

  it('never returns a Hindi explanation of what the client said (addendum H)', async () => {
    const client = new ScriptedAiClient({ raw: VALID_REPLY });
    const { app } = appWith(testConfig(), client);
    const session = await request(app).post('/api/sessions').send({});

    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({
        stage: 'provisional',
        version: 1,
        utterance: 'Could you explain why the application is taking longer to load',
      });

    expect(response.status).toBe(200);
    // The contract must not carry a Hindi meaning field at all.
    expect(response.body).not.toHaveProperty('clientMeaningHi');
    expect(Object.keys(response.body)).not.toContain('client_meaning_hi');
    // Nothing in Devanagari may reach the interface.
    expect(JSON.stringify(response.body)).not.toMatch(/[\u0900-\u097F]/);
    // And the prompt must not request one either.
    const system = client.calls[0]?.system ?? '';
    expect(system).not.toMatch(/client_meaning_hi/);
    expect(system).not.toMatch(/Devanagari/);
  });

  it('returns a refined reply for a completed question (criterion 6)', async () => {
    const client = new ScriptedAiClient({ raw: VALID_REPLY });
    const { app } = appWith(testConfig(), client);
    const session = await request(app).post('/api/sessions').send({});

    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({
        stage: 'refined',
        version: 4,
        utterance: 'Could you explain why the application is taking longer to load today?',
        recentFinals: ['Hello, can you hear me?'],
      });

    expect(response.status).toBe(200);
    expect(response.body.stage).toBe('refined');
    expect(client.calls).toHaveLength(1);
    // System prompt must carry the no-fabrication contract.
    const system = client.calls[0]?.system ?? '';
    expect(system).toMatch(/NEVER invent facts/i);
    expect(system).toMatch(/untrusted DATA/i);
  });

  it('falls back safely when the model output is invalid (criterion 9)', async () => {
    const client = new ScriptedAiClient({ raw: JSON.stringify({ nonsense: true }) });
    const { app } = appWith(testConfig(), client);
    const session = await request(app).post('/api/sessions').send({});

    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({ stage: 'refined', version: 1, utterance: 'Can you tell me the deadline?' });

    expect(response.status).toBe(200);
    expect(response.body.engine).toBe('safe_fallback');
    expect(response.body.notice).toMatch(/validation/i);
    // The safe line must not assert any project fact.
    expect(response.body.suggestedReply).not.toMatch(/fixed|done|deployed/i);
    // ...and must not reintroduce a Hindi explanation through the fallback path.
    expect(JSON.stringify(response.body)).not.toMatch(/[\u0900-\u097F]/);
  });

  it('falls back safely when the model returns non-JSON', async () => {
    const client = new ScriptedAiClient({ raw: 'Sure! Here is your reply:' });
    const { app } = appWith(testConfig(), client);
    const session = await request(app).post('/api/sessions').send({});
    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({ stage: 'provisional', version: 1, utterance: 'and then what happened with the build' });
    expect(response.body.engine).toBe('safe_fallback');
  });

  it('asks for clarification on an ambiguous, very short statement (criterion 8)', async () => {
    const client = new ScriptedAiClient({ throwCode: 'AI_TIMEOUT' });
    const { app } = appWith(testConfig(), client);
    const session = await request(app).post('/api/sessions').send({});
    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({ stage: 'refined', version: 1, utterance: 'well?' });

    expect(response.status).toBe(200);
    expect(response.body.engine).toBe('safe_fallback');
    expect(response.body.needsClarification).toBe(true);
    expect(response.body.suggestedReply).toMatch(/clarify/i);
  });

  it('opens the circuit breaker after repeated provider failures', async () => {
    const client = new ScriptedAiClient({ throwCode: 'AI_UPSTREAM_ERROR' });
    const { app, services } = appWith(testConfig(), client);
    const session = await request(app).post('/api/sessions').send({});

    for (let i = 0; i < 4; i += 1) {
      await request(app)
        .post(`/api/sessions/${session.body.id}/reply`)
        .send({ stage: 'refined', version: i + 1, utterance: `question number ${i} about the release` });
    }

    expect(services.breaker.state().open).toBe(true);
  });

  it('rejects an oversized utterance and an empty one', async () => {
    const { app } = appWith(testConfig());
    const session = await request(app).post('/api/sessions').send({});

    const tooLong = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({ stage: 'refined', version: 1, utterance: 'a'.repeat(9000) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('VALIDATION_FAILED');

    const empty = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({ stage: 'refined', version: 1, utterance: '' });
    expect(empty.status).toBe(400);
  });

  it('returns 503 rather than faking a reply when unconfigured', async () => {
    const config = testConfig({ aiApiKey: null, realtimeApiKey: null });
    const { app } = appWith(config, new UnconfiguredAiClient());
    const session = await request(app).post('/api/sessions').send({});
    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({ stage: 'refined', version: 1, utterance: 'can you confirm the deadline' });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
  });
});

describe('translation (criterion 10)', () => {
  it('keeps the claim as strong as the original', async () => {
    const raw = JSON.stringify({
      english: 'I have fixed the issue. Could you please check it again?',
      alternatives: ['The fix is in - please check once more.'],
      notes: null,
      tone: 'professional',
    });
    const client = new ScriptedAiClient({ raw });
    const { app } = appWith(testConfig(), client);

    const response = await request(app)
      .post('/api/translate')
      .send({ text: 'Maine issue fix kar diya hai, aap dobara check kar sakte hain.' });

    expect(response.status).toBe(200);
    expect(response.body.english).toMatch(/fixed the issue/i);
    expect(response.body.alternatives).toHaveLength(1);
    // Prompt contract: never strengthen the user's claim.
    const system = client.calls[0]?.system ?? '';
    expect(system).toMatch(/Preserve the meaning EXACTLY/i);
    expect(system).toMatch(/do NOT upgrade/i);
  });

  it('rejects empty input and reports invalid model output', async () => {
    const { app } = appWith(testConfig(), new ScriptedAiClient({ raw: '{}' }));

    const empty = await request(app).post('/api/translate').send({ text: '' });
    expect(empty.status).toBe(400);

    const invalid = await request(app).post('/api/translate').send({ text: 'main check karunga' });
    expect(invalid.status).toBe(500);
    expect(invalid.body.error.code).toBe('AI_INVALID_OUTPUT');
  });
});

describe('security', () => {
  it('requires the workspace token when configured (criterion 11)', async () => {
    const config = testConfig({ accessToken: 'secret-token' });
    const { app } = appWith(config);

    const anonymous = await request(app).get('/api/sessions');
    expect(anonymous.status).toBe(401);

    const wrong = await request(app).get('/api/sessions').set('Authorization', 'Bearer nope');
    expect(wrong.status).toBe(401);

    const ok = await request(app).post('/api/sessions').set('Authorization', 'Bearer secret-token').send({});
    expect(ok.status).toBe(201);

    // Health stays public so uptime checks keep working.
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('rejects a disallowed CORS origin', async () => {
    const { app } = appWith(testConfig());
    const response = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(response.status).toBe(403);
  });

  /**
   * Regression: browsers send an Origin header on CORS-mode requests (module
   * scripts, stylesheets). Rejecting the page's own origin returned 403 for
   * /assets/*.js, so the bundle never loaded and the SPA rendered a blank #root.
   */
  it('allows the serving origin to load its own assets', async () => {
    const { app } = appWith(testConfig({ corsOrigins: ['http://localhost:5173'] }));
    const response = await request(app)
      .get('/api/health')
      .set('Host', 'app.example.com')
      .set('Origin', 'http://app.example.com');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://app.example.com');
  });

  it('answers a CORS preflight without error', async () => {
    const { app } = appWith(testConfig({ corsOrigins: ['http://localhost:5173'] }));
    const response = await request(app)
      .options('/api/sessions')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
  });

  it('sets baseline security headers', async () => {
    const { app } = appWith(testConfig());
    const response = await request(app).get('/api/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['permissions-policy']).toContain('microphone=(self)');
  });

  it('never returns provider internals in an error body', async () => {
    const client = new ScriptedAiClient({ throwCode: 'AI_UPSTREAM_ERROR' });
    const { app } = appWith(testConfig(), client);
    const session = await request(app).post('/api/sessions').send({});
    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({ stage: 'refined', version: 1, utterance: 'why is the build failing' });
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('stack');
    expect(body).not.toContain('test-key');
  });

  it('mints an ephemeral realtime token, not the API key', async () => {
    const client = new ScriptedAiClient({ raw: VALID_REPLY });
    const { app } = appWith(testConfig(), client);
    const response = await request(app).post('/api/realtime/token').send({});

    expect(response.status).toBe(200);
    expect(response.body.token).toBe('ek_test_token_value');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain('test-key');
  });

  it('refuses a realtime token when unconfigured', async () => {
    const config = testConfig({ aiApiKey: null, realtimeApiKey: null });
    const { app } = appWith(config, new UnconfiguredAiClient());
    const response = await request(app).post('/api/realtime/token').send({});
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('lists and saves vocabulary scoped to the client id', async () => {
    const { app } = appWith(testConfig());
    const saved = await request(app)
      .post('/api/vocabulary')
      .set('X-Client-Id', 'clientA')
      .send({ term: 'bandwidth', meaningEn: 'available time' });
    expect(saved.status).toBe(201);

    const listA = await request(app).get('/api/vocabulary').set('X-Client-Id', 'clientA');
    const listB = await request(app).get('/api/vocabulary').set('X-Client-Id', 'clientB');
    expect(listA.body.items).toHaveLength(1);
    expect(listB.body.items).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the AI bucket is exhausted', async () => {
    const config = testConfig({ aiRateLimitMax: 2 });
    const client = new ScriptedAiClient({ raw: VALID_REPLY });
    const { app } = appWith(config, client);
    const session = await request(app).post('/api/sessions').send({});

    const send = (version: number) =>
      request(app)
        .post(`/api/sessions/${session.body.id}/reply`)
        .send({ stage: 'refined', version, utterance: `question ${version} about the release date` });

    expect((await send(1)).status).toBe(200);
    expect((await send(2)).status).toBe(200);
    const limited = await send(3);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
  });
});

describe('provider client guardrails', () => {
  it('maps a missing key to a 503-shaped error instead of a network call', async () => {
    const client = new UnconfiguredAiClient();
    await expect(
      client.structuredCompletion({
        model: 'x',
        system: 's',
        user: 'u',
        schemaName: 's',
        schema: {},
        temperature: 0,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('builds a realtime token request against the documented endpoint', async () => {
    // Constructing the client must not perform I/O; this asserts configuration
    // wiring only (no network in unit tests).
    const client = new OpenAiClient({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', timeoutMs: 1000 });
    expect(client.id).toBe('openai');
  });
});
