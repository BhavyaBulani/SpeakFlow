import { describe, expect, it, vi } from 'vitest';
import { deriveConfig } from '../src/server/config';
import { createReplyLiveness } from '../src/server/services/replyLiveness';

/**
 * The bug this covers: `isAiConfigured()` is true the moment `AI_PROVIDER=local`
 * is *chosen*, because `deriveConfig()` is synchronous and cannot probe a socket.
 * A user then saw "AI ready" with nothing running on loopback and every refined
 * reply arriving as a `safe_fallback`, which reads as a bad model rather than a
 * stopped one. These tests pin the difference between selected and running.
 */

function localConfig(overrides: Record<string, string> = {}) {
  return deriveConfig({
    NODE_ENV: 'test',
    AI_PROVIDER: 'local',
    AI_MODEL: 'qwen2.5:3b-instruct',
    ...overrides,
  });
}

describe('reply model liveness probe', () => {
  it('is not applicable to a hosted provider, and makes no request', async () => {
    const fetchImpl = vi.fn();
    const liveness = createReplyLiveness(deriveConfig({ NODE_ENV: 'test', AI_PROVIDER: 'openai' }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const state = await liveness.check();

    expect(state.applicable).toBe(false);
    expect(state.reachable).toBeNull();
    // Probing a third party from /health would be slow and wrong.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports reachable when the local endpoint answers', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    const liveness = createReplyLiveness(localConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const state = await liveness.check();

    expect(state.applicable).toBe(true);
    expect(state.reachable).toBe(true);
    expect(state.detail).toBe('');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The OpenAI-compatible model list is the probe: Ollama and LM Studio have it.
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toMatch(/\/v1\/models$/);
  });

  it('treats any HTTP answer as listening, including an auth error', async () => {
    // A 401 proves a process is bound to the port; that is the fact we report.
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const liveness = createReplyLiveness(localConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect((await liveness.check()).reachable).toBe(true);
  });

  it('reports unreachable with an actionable reason when nothing is listening', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const fetchImpl = vi.fn(async () => {
      throw refused;
    });
    const liveness = createReplyLiveness(
      localConfig({ AI_BASE_URL: 'http://127.0.0.1:11434/v1' }),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const state = await liveness.check();

    expect(state.reachable).toBe(false);
    // The reason must name both the address and the doc, or it is another
    // message that reads like "the model is bad".
    expect(state.detail).toContain('127.0.0.1:11434');
    expect(state.detail).toContain('LOCAL_MODEL.md');
  });

  it('never throws, so /api/health cannot be taken down by a dead model', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    const liveness = createReplyLiveness(localConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(liveness.check()).resolves.toMatchObject({ reachable: false });
  });

  it('caches the answer, and coalesces concurrent polls into one request', async () => {
    let clock = 1_000;
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const liveness = createReplyLiveness(localConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 5_000,
      now: () => clock,
    });

    await Promise.all([liveness.check(), liveness.check(), liveness.check()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Inside the TTL the cached answer is reused.
    clock += 1_000;
    await liveness.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past it, the probe runs again - a model that starts later must be noticed.
    clock += 10_000;
    await liveness.check();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('state() never triggers a probe', () => {
    const fetchImpl = vi.fn();
    const liveness = createReplyLiveness(localConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(liveness.state()).toMatchObject({ applicable: true, reachable: null, checkedAt: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
