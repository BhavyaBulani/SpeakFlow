import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDER_PRESETS, deriveConfig, isAiConfigured } from '../src/server/config';
import { createServices } from '../src/server/services';
import { OpenAiClient, UnconfiguredAiClient } from '../src/server/services/openai';

/**
 * The local open-source model path (Ollama / LM Studio / llama.cpp).
 *
 * This is the only configuration that is genuinely unbounded at ₹0, because
 * there is no quota to exhaust — but it runs on the operator's own hardware, so
 * it is opt-in and must never be the path an end user is required to take.
 *
 * The bug these tests lock down: "has an API key" was used as the definition of
 * "is configured", which makes a perfectly working keyless local server report
 * itself as unconfigured and silently serve canned fallback replies instead.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local provider configuration', () => {
  it('treats a keyless local server as configured', () => {
    const config = deriveConfig({ NODE_ENV: 'test', AI_PROVIDER: 'local' });

    expect(config.aiProvider).toBe('local');
    expect(config.aiApiKey).toBeNull();
    expect(isAiConfigured(config)).toBe(true);
  });

  it('defaults to a loopback endpoint, never a public host', () => {
    const config = deriveConfig({ NODE_ENV: 'test', AI_PROVIDER: 'local' });

    expect(config.aiBaseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(config.aiModel).toBe('qwen2.5:7b-instruct');
    // Free-tier hosts only guarantee syntactically valid JSON, and so does a
    // local model: the schema has to be restated in the prompt.
    expect(config.aiJsonMode).toBe('json_object');
  });

  it('still reports unconfigured when nothing is set at all', () => {
    const config = deriveConfig({ NODE_ENV: 'test' });
    expect(config.aiApiKey).toBeNull();
    expect(isAiConfigured(config)).toBe(false);
  });

  it('wires a real client rather than the unconfigured stub', () => {
    const config = deriveConfig({ NODE_ENV: 'test', AI_PROVIDER: 'local' });
    const services = createServices(config);

    expect(services.ai).not.toBeInstanceOf(UnconfiguredAiClient);
    expect(services.ai.id).toBe('local');
  });

  it('keeps the model name and base URL overridable', () => {
    const config = deriveConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'local',
      AI_MODEL: 'qwen2.5:3b-instruct',
      AI_BASE_URL: 'http://127.0.0.1:1234/v1',
    });

    expect(config.aiModel).toBe('qwen2.5:3b-instruct');
    expect(config.aiBaseUrl).toBe('http://127.0.0.1:1234/v1');
  });

  it('exposes the local preset for documentation and the UI', () => {
    expect(AI_PROVIDER_PRESETS.local.baseUrl).toContain('127.0.0.1');
  });
});

describe('OpenAiClient against a local server', () => {
  it('sends no Authorization header when there is no key', async () => {
    let capturedHeaders: Record<string, string> = {};

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"suggested_reply":"ok"}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const client = new OpenAiClient({
      id: 'local',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      timeoutMs: 2000,
      jsonMode: 'json_object',
    });

    const result = await client.structuredCompletion({
      model: 'qwen2.5:7b-instruct',
      system: 'system',
      user: 'user',
      schemaName: 'reply',
      schema: { type: 'object' },
      temperature: 0.2,
    });

    expect(capturedHeaders.Authorization).toBeUndefined();
    expect(capturedHeaders['Content-Type']).toBe('application/json');
    expect(result.raw).toContain('suggested_reply');
  });

  it('still sends a bearer token when a key is configured', async () => {
    let authorization: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        authorization = ((init?.headers ?? {}) as Record<string, string>).Authorization;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const client = new OpenAiClient({
      id: 'groq',
      apiKey: 'gsk_x',
      baseUrl: 'https://api.groq.com/openai/v1',
      timeoutMs: 2000,
      jsonMode: 'json_object',
    });
    await client.structuredCompletion({
      model: 'llama-3.3-70b-versatile',
      system: 'system',
      user: 'user',
      schemaName: 'reply',
      schema: { type: 'object' },
      temperature: 0.2,
    });

    expect(authorization).toBe('Bearer gsk_x');
  });
});
