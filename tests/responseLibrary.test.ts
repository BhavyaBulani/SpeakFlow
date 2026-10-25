import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server/app';
import { deriveConfig, type ServerConfig } from '../src/server/config';
import { UnconfiguredAiClient } from '../src/server/services/openai';
import { PROVISIONAL_POLICY, decideProvisional } from '../src/shared/replyPipeline';
import {
  FAST_PATH_MIN_SCORE,
  RESPONSE_LIBRARY,
  getRecord,
  matchFastPath,
} from '../src/shared/responseLibrary';

/**
 * The local fast path (prompt 2 §2 Stage A, master §6 Stage 2).
 *
 * Two things must hold and are easy to break:
 *  1. it must return a genuinely useful holding line for common partial speech, in
 *     microseconds and with no provider call;
 *  2. it must NEVER produce a factual answer, because a partial sentence cannot
 *     justify one, and it must decline (null) rather than guess.
 */

describe('response library contents', () => {
  it('covers every category the master prompt lists', () => {
    const categories = new Set(RESPONSE_LIBRARY.map((record) => record.category));
    for (const required of [
      'acknowledge-question',
      'ask-clarification',
      'confirm-understanding',
      'explain-blocker',
      'negotiate-deadline',
      'missed-deadline',
      'project-status',
      'ask-for-time',
      'disagree-politely',
      'express-uncertainty',
      'confirm-next-step',
      'ask-repeat',
      'out-of-scope',
      'verify-before-committing',
    ]) {
      expect(categories, `missing category: ${required}`).toContain(required);
    }
  });

  it('has unique ids', () => {
    const ids = RESPONSE_LIBRARY.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never contains a fact placeholder that could be filled with an invented value', () => {
    for (const record of RESPONSE_LIBRARY) {
      const texts = [record.reply, ...record.alternatives, ...Object.values(record.variants ?? {})];
      for (const text of texts) {
        expect(text, `placeholder in ${record.id}`).not.toMatch(/\{[^}]*\}|<[^>]*>|\[[^\]]*\]|__/);
      }
    }
  });

  it('keeps every reply short enough to say out loud', () => {
    for (const record of RESPONSE_LIBRARY) {
      const texts = [record.reply, ...record.alternatives, ...Object.values(record.variants ?? {})];
      for (const text of texts) {
        // Roughly two spoken sentences.
        expect(text.length, `too long in ${record.id}: "${text}"`).toBeLessThanOrEqual(170);
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('contains no Devanagari, so no Hindi explanation can leak into the UI', () => {
    const everything = JSON.stringify(RESPONSE_LIBRARY);
    expect(everything).not.toMatch(/[\u0900-\u097F]/);
  });

  it('never states a fact as certain in the uncertainty record', () => {
    const record = getRecord('uncertain');
    expect(record).not.toBeNull();
    expect(record?.reply).toMatch(/verify|confirm/i);
  });
});

describe('matchFastPath', () => {
  it('returns null rather than guessing when nothing matches', () => {
    expect(matchFastPath('mmm', 'professional')).toBeNull();
    expect(matchFastPath('the weather is nice today', 'professional')).toBeNull();
    expect(matchFastPath('', 'professional')).toBeNull();
  });

  it('answers a partial question with a holding line, not an answer', () => {
    const match = matchFastPath('could you explain why the application is taking longer to', 'professional');
    expect(match).not.toBeNull();
    expect(match?.record.category).toBe('acknowledge-question');
    // The whole point: it must not claim to know the cause.
    expect(match?.reply.toLowerCase()).not.toMatch(/because|due to|the cause is/);
    expect(match?.reply).toMatch(/check|look|confirm|moment/i);
  });

  it('routes a deadline question to the negotiation record', () => {
    const match = matchFastPath('so the client is asking whether we can move the deadline to Friday', 'professional');
    expect(match?.record.category).toBe('negotiate-deadline');
  });

  it('routes an unresolved dependency to the blocker record', () => {
    const match = matchFastPath('I am blocked on one dependency for the release', 'professional');
    expect(match?.record.category).toBe('explain-blocker');
  });

  it('routes a bad connection to the repeat record', () => {
    const match = matchFastPath('the audio is breaking up a little on my side', 'professional');
    expect(match?.record.category).toBe('ask-repeat');
    expect(match?.needsClarification).toBe(true);
  });

  it('routes an unmatched next-step request to confirm-next-step, not to uncertainty', () => {
    const match = matchFastPath('can you confirm the next step and who is picking it up', 'professional');
    expect(match?.record.category).toBe('confirm-next-step');
  });

  it('applies the tone variant when the record defines one', () => {
    const concise = matchFastPath('could you check the deployment please', 'concise');
    const professional = matchFastPath('could you check the deployment please', 'professional');
    expect(professional?.reply).not.toBe(concise?.reply);
    expect(professional?.reply).toBe(getRecord('acknowledge')?.reply);
    expect(concise?.reply).toBe(getRecord('acknowledge')?.variants?.concise);
  });

  it('falls back to the default reply for a tone the record does not define', () => {
    const match = matchFastPath('can you say that again please', 'empathetic');
    expect(match?.reply).toBe(getRecord('ask-repeat')?.reply);
  });

  it('only scores at or above the documented threshold', () => {
    const match = matchFastPath('deadline', 'professional');
    // One cue word alone is below the threshold, so it must decline.
    expect(match).toBeNull();
    expect(FAST_PATH_MIN_SCORE).toBe(2);
  });

  it('returns a stable record for the same input', () => {
    const a = matchFastPath('we also need to add reporting to the same sprint', 'professional');
    const b = matchFastPath('we also need to add reporting to the same sprint', 'professional');
    expect(a?.record.id).toBe(b?.record.id);
  });
});

describe('max-wait safeguard (prompt 2 §3)', () => {
  const base = {
    utterance: 'so the client is asking whether we can move the deadline to friday at the latest',
    lastRequestedText: 'so the client is asking',
    now: 10_000,
    inFlight: false,
    requestsThisUtterance: 1,
  };

  it('forces a fire past the max-wait even though the throttle would block', () => {
    const decision = decideProvisional({
      ...base,
      // Last request fired 200 ms ago: inside minIntervalMs (1100).
      lastRequestedAt: 9_800,
      utteranceStartedAt: 10_000 - (PROVISIONAL_POLICY.maxWaitMs + 100),
    });

    expect(decision.action).toBe('request');
    expect(decision.forcedByMaxWait).toBe(true);
  });

  it('does not force while the utterance is still young', () => {
    const decision = decideProvisional({
      ...base,
      lastRequestedAt: 9_800,
      utteranceStartedAt: 9_900,
    });

    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('throttled');
    expect(decision.forcedByMaxWait).toBe(false);
  });

  it('never force-fires unchanged text, even long past the max-wait', () => {
    const decision = decideProvisional({
      ...base,
      lastRequestedText: base.utterance,
      lastRequestedAt: 9_800,
      utteranceStartedAt: 1_000,
    });

    expect(decision.action).toBe('skip');
    expect(decision.forcedByMaxWait).toBe(false);
  });

  it('still respects the per-utterance cap', () => {
    const decision = decideProvisional({
      ...base,
      lastRequestedAt: 9_800,
      utteranceStartedAt: 1_000,
      requestsThisUtterance: PROVISIONAL_POLICY.maxRequestsPerUtterance,
    });

    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('budget-exhausted');
  });

  it('honours a configurable max-wait', () => {
    const decision = decideProvisional({
      ...base,
      lastRequestedAt: 9_800,
      utteranceStartedAt: 9_000,
      maxWaitMs: 500,
    });
    expect(decision.forcedByMaxWait).toBe(true);
  });
});

describe('fast path through the API', () => {
  function appWith(overrides: { aiClient?: UnconfiguredAiClient; config?: Partial<ServerConfig> } = {}) {
    const config: ServerConfig = {
      ...deriveConfig({ NODE_ENV: 'test', AI_PROVIDER: 'groq', AI_API_KEY: 'gsk_test' }),
      ...overrides.config,
    };
    return createApp({
      config,
      overrides: overrides.aiClient === undefined ? {} : { aiClient: overrides.aiClient },
    });
  }

  async function postReply(
    app: ReturnType<typeof createApp>['app'],
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    const session = await request(app).post('/api/sessions').send({});
    return request(app).post(`/api/sessions/${session.body.id}/reply`).send(body);
  }

  it('answers a provisional request from the library and reports it honestly', async () => {
    const { app } = appWith();

    const response = await postReply(app, {
      stage: 'provisional',
      version: 1,
      utterance: 'could you explain why the application is taking longer to',
      tone: 'professional',
    });

    expect(response.status).toBe(200);
    expect(response.body.engine).toBe('local_library');
    expect(response.body.model).toBe('response-library');
    expect(response.body.stage).toBe('provisional');
    // Must not be presented as model output.
    expect(response.body.engine).not.toBe('openai');
    expect(response.body.engine).not.toBe('groq');
  });

  it('works with NO usable AI provider at all, which is the ₹0 path', async () => {
    // No key, no mock: a request would normally 503. The library still answers.
    const { app } = appWith({
      aiClient: new UnconfiguredAiClient(),
      config: { aiApiKey: null, mockAi: false },
    });

    const response = await postReply(app, {
      stage: 'provisional',
      version: 1,
      utterance: 'can you confirm the next step and who is picking it up',
      tone: 'friendly',
    });

    expect(response.status).toBe(200);
    expect(response.body.engine).toBe('local_library');
    expect(response.body.suggestedReply.length).toBeGreaterThan(0);
  });

  it('does not use the library for a refined request', async () => {
    const { app } = appWith();
    const response = await postReply(app, {
      stage: 'refined',
      version: 1,
      utterance: 'can you confirm the next step and who is picking it up',
      tone: 'professional',
    });
    // Refined goes to the provider (mock client here), never the library.
    expect(response.body.engine).not.toBe('local_library');
  });

  it('defers to the model when the user pinned an explicit intent', async () => {
    const { app } = appWith();
    const response = await postReply(app, {
      stage: 'provisional',
      version: 1,
      utterance: 'could you explain why the application is taking longer to',
      tone: 'professional',
      replyIntent: 'disagree-politely',
    });
    expect(response.body.engine).not.toBe('local_library');
  });

  it('does not use the library when rewriting an existing reply', async () => {
    const { app } = appWith();
    const response = await postReply(app, {
      stage: 'provisional',
      version: 1,
      utterance: 'could you check the deployment please',
      tone: 'professional',
      refine: 'shorter',
      previousReply: 'Let me check that and come back to you.',
    });
    expect(response.body.engine).not.toBe('local_library');
  });

  it('can be switched off entirely by configuration', async () => {
    const { app } = appWith({ config: { fastPathEnabled: false } });
    const response = await postReply(app, {
      stage: 'provisional',
      version: 1,
      utterance: 'could you explain why the application is taking longer to',
      tone: 'professional',
    });
    expect(response.body.engine).not.toBe('local_library');
  });

  it('declines unmatched speech and falls through to the provider', async () => {
    const { app } = appWith();
    const response = await postReply(app, {
      stage: 'provisional',
      version: 1,
      utterance: 'the weather outside is quite pleasant today actually',
      tone: 'professional',
    });
    expect(response.body.engine).not.toBe('local_library');
  });
});
