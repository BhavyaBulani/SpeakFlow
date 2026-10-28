import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The serverless entry must build the app without binding a port, without
 * serving the SPA, and without leaving an interval behind. These are the three
 * ways a server entry point silently fails on a serverless host, and all three
 * are invisible in the browser until the first cold start.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

function setMinimalEnv(extra: NodeJS.ProcessEnv = {}): void {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'production',
    MOCK_AI: '1',
    AI_PROVIDER: 'openai',
    APP_ACCESS_TOKEN: 'serverless-test-token',
    ENABLE_VOCAB_PERSISTENCE: '0',
    ...extra,
  };
  if (extra.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
}

describe('serverless entry', () => {
  it('builds the app without binding a port', async () => {
    setMinimalEnv();
    const http = await import('node:http');
    const listen = vi.spyOn(http.default.Server.prototype, 'listen');

    const { getServerlessApp } = await import('../src/server/serverless');
    const { app } = getServerlessApp();

    expect(typeof app).toBe('function');
    expect(listen).not.toHaveBeenCalled();
    listen.mockRestore();
  });

  it('gates an unknown /api path before revealing that it does not exist', async () => {
    setMinimalEnv();
    const { getServerlessApp } = await import('../src/server/serverless');
    const request = (await import('supertest')).default;

    // The auth gate is mounted before the 404 handler on purpose: an anonymous
    // caller must not be able to enumerate which API routes exist by comparing
    // 401 against 404.
    const anonymous = await request(getServerlessApp().app).get('/api/does-not-exist');
    expect(anonymous.status).toBe(401);

    // With a token, an unknown route is a JSON 404 - never index.html. Returning
    // the SPA shell for a bad API URL is what once made a client-side URL bug
    // look like "the server is down", because the 200 body was the app's HTML.
    const authed = await request(getServerlessApp().app)
      .get('/api/does-not-exist')
      .set('Authorization', 'Bearer serverless-test-token');
    expect(authed.status).toBe(404);
    expect(authed.headers['content-type']).toContain('application/json');
  });

  it('memoises the app across invocations', async () => {
    setMinimalEnv();
    const { getServerlessApp } = await import('../src/server/serverless');
    expect(getServerlessApp()).toBe(getServerlessApp());
  });

  it('uses the in-memory store when DATABASE_URL is absent', async () => {
    setMinimalEnv();
    const { getServerlessApp } = await import('../src/server/serverless');
    expect(getServerlessApp().services.sessions.kind).toBe('memory');
  });

  it('selects the Postgres store when DATABASE_URL is set, without connecting', async () => {
    setMinimalEnv({ DATABASE_URL: 'postgresql://user:pw@db.example.com:5432/app' });
    const { getServerlessApp } = await import('../src/server/serverless');
    const bundle = getServerlessApp();

    expect(bundle.services.sessions.kind).toBe('postgres');
    // Constructing the store must not open a socket: on a cold start the first
    // request pays for the connection, not the module import. `close()` on a
    // never-used lazy pool resolves immediately for that reason.
    await expect(bundle.services.sessions.close()).resolves.toBeUndefined();
  });

  it('answers /api/health and names the live store', async () => {
    setMinimalEnv();
    const { getServerlessApp } = await import('../src/server/serverless');
    const request = (await import('supertest')).default;

    const response = await request(getServerlessApp().app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.sessionStore).toBe('memory');
    expect(typeof response.body.activeSessions).toBe('number');
  });

  it('keeps health answerable when the session store throws', async () => {
    setMinimalEnv();
    const { createApp } = await import('../src/server/app');
    const { deriveConfig } = await import('../src/server/config');
    const { MemorySessionStore } = await import('../src/server/services/sessions');
    const { MockAiClient } = await import('../src/server/services/openai');
    const request = (await import('supertest')).default;

    const broken = new MemorySessionStore({ ttlMinutes: 60 });
    broken.count = async () => {
      throw new Error('connection terminated unexpectedly');
    };

    const { app } = createApp({
      config: deriveConfig(),
      overrides: { sessionStore: broken, aiClient: new MockAiClient() },
      serveStatic: false,
    });

    const response = await request(app).get('/api/health');

    // The reply pipeline is still answerable when the store is not, so the
    // status stays 200 and the failure becomes a null field. A 5xx here would
    // report the whole app down when only the store is.
    expect(response.status).toBe(200);
    expect(response.body.activeSessions).toBeNull();
  });
});
