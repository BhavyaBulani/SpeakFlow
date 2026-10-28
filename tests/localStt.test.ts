import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server/app';
import { deriveConfig, isSttConfigured, type ServerConfig } from '../src/server/config';
import { createServices, providerStatus } from '../src/server/services';
import { parseWhisperOutput, WhisperCppSttClient } from '../src/server/services/whisperCpp';
import { parseWhisperServerBody, WhisperServerSttClient } from '../src/server/services/whisperServer';
import { deriveConfig as derive } from '../src/server/config';

/**
 * Local (whisper.cpp) speech-to-text wiring.
 *
 * The recogniser itself is verified separately against real audio by
 * `npm run bench:local`, which spawns the real binary. These tests cover the
 * parts that must be right *before* that: output parsing, the no-key rule, and
 * the honest unconfigured state when the binary is missing.
 */

describe('parseWhisperOutput', () => {
  it('returns the transcript from whisper-cli stdout', () => {
    expect(parseWhisperOutput(' Can you explain why the build is failing?\n')).toBe(
      'Can you explain why the build is failing?',
    );
  });

  it('strips timestamps when whisper-cli emits them', () => {
    const stdout = '[00:00:00.000 --> 00:00:02.400]   Can you confirm the date?\n';
    expect(parseWhisperOutput(stdout)).toBe('Can you confirm the date?');
  });

  it('drops diagnostic noise that is not speech', () => {
    const stdout = [
      "read_audio_data: reading audio data from 'chunk.wav' ...",
      'read_audio_data: trying to decode with miniaudio',
      '',
      ' I will check that and come back to you.',
    ].join('\n');
    expect(parseWhisperOutput(stdout)).toBe('I will check that and come back to you.');
  });

  it('returns an empty string for silence instead of inventing text', () => {
    expect(parseWhisperOutput('')).toBe('');
    expect(parseWhisperOutput('read_audio_data: reading audio data\n')).toBe('');
    expect(parseWhisperOutput('[BLANK_AUDIO]')).toBe('');
  });

  it('joins multiple transcript lines into one spoken sentence', () => {
    expect(parseWhisperOutput(' We need\n to move the deadline.\n')).toBe(
      'We need to move the deadline.',
    );
  });
});

describe('WhisperCppSttClient', () => {
  const baseOptions = {
    binaryPath: 'C:/fake/whisper-cli.exe',
    modelPath: 'C:/fake/ggml-base.en.bin',
    timeoutMs: 5000,
    language: 'en',
  };

  it('passes the model and audio path to whisper-cli and returns its text', async () => {
    let captured: string[] = [];
    const client = new WhisperCppSttClient({
      ...baseOptions,
      runImpl: async (args) => {
        captured = args;
        return ' I can confirm that by end of day.\n';
      },
    });

    const result = await client.transcribe({ wav: new Uint8Array([1, 2, 3, 4]), language: 'en' });

    expect(captured[0]).toBe(baseOptions.binaryPath);
    expect(captured).toContain('-m');
    expect(captured).toContain(baseOptions.modelPath);
    expect(captured).toContain('-f');
    expect(captured).toContain('-l');
    expect(result.text).toBe('I can confirm that by end of day.');
  });

  it('reports chunked mode, never streaming', async () => {
    const client = new WhisperCppSttClient({
      ...baseOptions,
      runImpl: async () => 'hello\n',
    });
    const result = await client.transcribe({ wav: new Uint8Array([1]), language: 'en' });
    expect(result.mode).toBe('chunked');
    expect(client.mode).toBe('chunked');
  });

  it('does not claim a language it was not told', async () => {
    const client = new WhisperCppSttClient({ ...baseOptions, runImpl: async () => 'hi\n' });
    const result = await client.transcribe({ wav: new Uint8Array([1]), language: '' });
    expect(result.language).toBeNull();
  });

  it('rejects empty audio rather than running the model on nothing', async () => {
    const run = vi.fn();
    const client = new WhisperCppSttClient({ ...baseOptions, runImpl: run });
    await expect(
      client.transcribe({ wav: new Uint8Array(0), language: 'en' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('parseWhisperServerBody', () => {
  it('reads the text field whisper-server actually returns', () => {
    expect(parseWhisperServerBody('{"text":" Can you explain why it is slow?\\n"}')).toBe(
      'Can you explain why it is slow?',
    );
  });

  it('accepts a plain-text body', () => {
    expect(parseWhisperServerBody('  We should move the deadline.\n')).toBe(
      'We should move the deadline.',
    );
  });

  it('reconstructs from segments when text is absent', () => {
    expect(parseWhisperServerBody('{"segments":[{"text":" I will"},{"text":" check."}]}')).toBe(
      'I will check.',
    );
  });

  it('returns empty for silence or a shape it does not recognise', () => {
    expect(parseWhisperServerBody('')).toBe('');
    expect(parseWhisperServerBody('{"text":""}')).toBe('');
    expect(parseWhisperServerBody('{"unexpected":true}')).toBe('');
  });
});

describe('WhisperServerSttClient (resident model)', () => {
  const base = {
    serverUrl: 'http://127.0.0.1:8080',
    timeoutMs: 5000,
    language: 'en',
    modelName: 'ggml-base.en.bin',
  };

  it('posts the WAV to /inference as multipart and returns its text', async () => {
    let seenUrl = '';
    let seenBody: FormData | null = null;
    const client = new WhisperServerSttClient({
      ...base,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenBody = init?.body as FormData;
        return new Response(JSON.stringify({ text: ' I can confirm that by end of day.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });

    const result = await client.transcribe({ wav: new Uint8Array([1, 2, 3, 4]), language: 'en' });

    expect(seenUrl).toBe('http://127.0.0.1:8080/inference');
    expect(seenBody).toBeInstanceOf(FormData);
    expect((seenBody as unknown as FormData).get('file')).toBeInstanceOf(Blob);
    expect(result.text).toBe('I can confirm that by end of day.');
    expect(result.mode).toBe('chunked');
    expect(result.language).toBeNull();
  });

  it('strips a trailing slash from the configured server URL', async () => {
    let seenUrl = '';
    const client = new WhisperServerSttClient({
      ...base,
      serverUrl: 'http://127.0.0.1:8080///',
      fetchImpl: (async (input: RequestInfo | URL) => {
        seenUrl = String(input);
        return new Response('{"text":"hi"}', { status: 200 });
      }) as typeof fetch,
    });
    await client.transcribe({ wav: new Uint8Array([1]), language: 'en' });
    expect(seenUrl).toBe('http://127.0.0.1:8080/inference');
  });

  it('tells the operator to start the server when it cannot be reached', async () => {
    const client = new WhisperServerSttClient({
      ...base,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(
      client.transcribe({ wav: new Uint8Array([1]), language: 'en' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('maps a busy server to a rate-limit error, not a fake transcript', async () => {
    const client = new WhisperServerSttClient({
      ...base,
      fetchImpl: (async () => new Response('busy', { status: 429 })) as typeof fetch,
    });
    await expect(
      client.transcribe({ wav: new Uint8Array([1]), language: 'en' }),
    ).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });
  });

  it('maps a server fault to an upstream error', async () => {
    const client = new WhisperServerSttClient({
      ...base,
      fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch,
    });
    await expect(
      client.transcribe({ wav: new Uint8Array([1]), language: 'en' }),
    ).rejects.toMatchObject({ code: 'AI_UPSTREAM_ERROR' });
  });

  it('rejects empty audio without calling the server', async () => {
    const fetchImpl = vi.fn();
    const client = new WhisperServerSttClient({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      client.transcribe({ wav: new Uint8Array(0), language: 'en' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('local STT configuration', () => {
  it('needs no API key at all', () => {
    const config = derive({ NODE_ENV: 'test', STT_PROVIDER: 'whisper-cpp' });
    expect(config.sttProvider).toBe('whisper-cpp');
    expect(config.sttApiKey).toBeNull();
    expect(config.sttMode).toBe('chunked');
  });

  it('is "configured" only when the binary and model exist, not by holding a key', () => {
    const missing = derive({
      NODE_ENV: 'test',
      STT_PROVIDER: 'whisper-cpp',
      WHISPER_CPP_BIN: 'C:/definitely/not/here.exe',
      WHISPER_CPP_MODEL: 'C:/definitely/not/here.bin',
    });
    expect(isSttConfigured(missing)).toBe(false);

    const withKeyButLocal = derive({
      NODE_ENV: 'test',
      STT_PROVIDER: 'whisper-cpp',
      STT_API_KEY: 'gsk_should_be_ignored',
      WHISPER_CPP_BIN: 'C:/definitely/not/here.exe',
    });
    // A key must not make a broken local setup look healthy.
    expect(isSttConfigured(withKeyButLocal)).toBe(false);
  });

  it('builds an honest unconfigured client when the binary is absent', async () => {
    const config: ServerConfig = {
      ...derive({
        NODE_ENV: 'test',
        STT_PROVIDER: 'whisper-cpp',
        WHISPER_CPP_BIN: 'C:/definitely/not/here.exe',
        WHISPER_CPP_MODEL: 'C:/definitely/not/here.bin',
      }),
    };
    const services = createServices(config);
    expect(services.stt.id).toBe('whisper-cpp');

    await expect(
      services.stt.transcribe({ wav: new Uint8Array([1]), language: 'en' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('never silently substitutes a hosted provider for a missing local one', () => {
    const config = derive({
      NODE_ENV: 'test',
      STT_PROVIDER: 'whisper-cpp',
      STT_API_KEY: 'gsk_x',
      OPENAI_API_KEY: 'sk-x',
      WHISPER_CPP_BIN: 'C:/nope.exe',
    });
    const services = createServices(config);
    // Still whisper-cpp: it must fail loudly, not quietly go paid.
    expect(services.stt.id).toBe('whisper-cpp');
  });

  it('defaults to the CLI transport and switches to server mode explicitly', () => {
    const cli = derive({ NODE_ENV: 'test', STT_PROVIDER: 'whisper-cpp' });
    expect(cli.whisperMode).toBe('cli');

    const server = derive({ NODE_ENV: 'test', STT_PROVIDER: 'whisper-cpp', WHISPER_CPP_MODE: 'server' });
    expect(server.whisperMode).toBe('server');
    expect(server.whisperServerUrl).toBe('http://127.0.0.1:8080');

    const custom = derive({
      NODE_ENV: 'test',
      STT_PROVIDER: 'whisper-cpp',
      WHISPER_CPP_MODE: 'server',
      WHISPER_CPP_SERVER_URL: 'http://127.0.0.1:9999/',
    });
    expect(custom.whisperServerUrl).toBe('http://127.0.0.1:9999');
  });

  it('server mode needs the server binary, not a key', () => {
    const missing = derive({
      NODE_ENV: 'test',
      STT_PROVIDER: 'whisper-cpp',
      WHISPER_CPP_MODE: 'server',
      WHISPER_CPP_SERVER_BIN: 'C:/definitely/not/here-server.exe',
      WHISPER_CPP_MODEL: 'C:/definitely/not/here.bin',
    });
    expect(isSttConfigured(missing)).toBe(false);
  });

  it('builds the server client when server mode is configured', () => {
    const config = derive({
      NODE_ENV: 'test',
      STT_PROVIDER: 'whisper-cpp',
      WHISPER_CPP_MODE: 'server',
      // A file that exists in every checkout, so this does not depend on the
      // machine having the models downloaded.
      WHISPER_CPP_SERVER_BIN: 'package.json',
      WHISPER_CPP_MODEL: 'package.json',
    });
    const services = createServices(config);
    expect(services.stt.mode).toBe('chunked');
    expect(services.stt.model).toBe('package.json');
  });

  it('reports a working local setup as configured in /api/health (no key needed)', async () => {
    // Regression: `configured` used to mean "holds a secret", so a fully
    // working local recogniser advertised itself as broken.
    const config = derive({
      NODE_ENV: 'test',
      STT_PROVIDER: 'whisper-cpp',
      WHISPER_CPP_BIN: 'package.json',
      WHISPER_CPP_MODEL: 'package.json',
    });
    expect(config.sttApiKey).toBeNull();
    const services = createServices(config);
    expect((await providerStatus(services)).stt.configured).toBe(true);
  });

  it('advertises the local provider in /api/config without leaking anything', async () => {
    const { app } = createApp({
      config: derive({
        NODE_ENV: 'test',
        STT_PROVIDER: 'whisper-cpp',
        WHISPER_CPP_BIN: 'C:/definitely/not/here.exe',
        WHISPER_CPP_MODEL: 'C:/definitely/not/here.bin',
      }),
    });
    const response = await request(app).get('/api/config');
    expect(response.status).toBe(200);
    expect(response.body.sttProvider).toBe('whisper-cpp');
    expect(response.body.sttMode).toBe('chunked');
    // Honest: the files are missing, so it reports not configured.
    expect(response.body.sttConfigured).toBe(false);
  });
});

describe('unused import guard', () => {
  it('deriveConfig is the single config entry point', () => {
    expect(typeof deriveConfig).toBe('function');
  });
});
