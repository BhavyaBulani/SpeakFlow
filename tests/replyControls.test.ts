import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server/app';
import { deriveConfig, type ServerConfig } from '../src/server/config';
import type {
  AiClient,
  StructuredCompletionRequest,
  StructuredCompletionResult,
} from '../src/server/services/openai';
import {
  buildReplySystemPrompt,
  buildReplyUserPrompt,
  buildTranslationSystemPrompt,
} from '../src/server/services/prompts';
import { replyRequestSchema } from '../src/shared/schemas';
import type { ReplyIntent, ReplyTone } from '../src/shared/types';

/**
 * Tone, intent and rewrite controls (spec §5, addendum D/E).
 *
 * The product risk here is subtle: a control that appears in the UI but never
 * changes the prompt is worse than no control, because the user believes they
 * steered the reply. These tests assert the text actually reaching the model.
 */

const ALL_TONES: ReplyTone[] = [
  'professional',
  'friendly',
  'concise',
  'confident',
  'diplomatic',
  'empathetic',
];

const ALL_INTENTS: ReplyIntent[] = [
  'answer',
  'clarify',
  'ask-for-time',
  'acknowledge',
  'disagree-politely',
  'negotiate',
  'explain-delay',
  'confirm',
];

function buildSystem(overrides: {
  tone?: ReplyTone;
  replyIntent?: ReplyIntent | null;
  refine?: 'simpler' | 'shorter' | 'natural' | 'formal' | null;
}): string {
  return buildReplySystemPrompt({
    stage: 'refined',
    tone: overrides.tone ?? 'professional',
    utteranceUnfinished: false,
    userContext: '',
    replyIntent: overrides.replyIntent ?? null,
    refine: overrides.refine ?? null,
  });
}

const VALID_REPLY = JSON.stringify({
  suggested_reply: 'I will check and let you know.',
  alternative_reply: null,
  needs_clarification: false,
  facts_to_verify: [],
  confidence: 'medium',
  intent: 'question',
});

/** Records the exact prompt sent, so a control that never reaches the model fails. */
class RecordingAiClient implements AiClient {
  readonly id = 'openai' as const;
  calls: StructuredCompletionRequest[] = [];

  async structuredCompletion(req: StructuredCompletionRequest): Promise<StructuredCompletionResult> {
    this.calls.push(req);
    return { raw: VALID_REPLY, model: req.model, latencyMs: 1, usage: null };
  }

  async createTranscriptionToken(): Promise<never> {
    throw new Error('not used in this test');
  }
}

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...deriveConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'test-key' }),
    ...overrides,
  };
}

describe('reply tone', () => {
  it('produces a distinct instruction for every one of the six tones', () => {
    const texts = ALL_TONES.map((tone) => buildSystem({ tone }));
    // All six must differ: a copy-paste slip would otherwise leave two buttons
    // doing the same thing.
    expect(new Set(texts).size).toBe(ALL_TONES.length);
    for (const text of texts) expect(text).toContain('Tone:');
  });

  it('never lets a tone rule weaken the no-invention rules', () => {
    for (const tone of ALL_TONES) {
      const text = buildSystem({ tone });
      expect(text).toMatch(/NEVER invent facts/i);
      expect(text).toMatch(/Never promise a deadline/i);
    }
  });

  it('does not let the confident tone authorise false claims', () => {
    const text = buildSystem({ tone: 'confident' });
    expect(text).toMatch(/do not claim facts you do not have/i);
  });
});

describe('response intent', () => {
  it('emits a specific instruction for each of the eight intents', () => {
    for (const intent of ALL_INTENTS) {
      const text = buildSystem({ replyIntent: intent });
      expect(text).toContain('INTENT:');
    }
    const texts = ALL_INTENTS.map((intent) => buildSystem({ replyIntent: intent }));
    expect(new Set(texts).size).toBe(ALL_INTENTS.length);
  });

  it('says the intent overrides the stage guidance when they conflict', () => {
    expect(buildSystem({ replyIntent: 'clarify' })).toMatch(/overrides the stage guidance/i);
  });

  it('omits intent guidance entirely when the user left it on automatic', () => {
    expect(buildSystem({ replyIntent: null })).not.toContain('INTENT:');
  });

  it('forbids inventing a delay cause for the explain-delay intent', () => {
    expect(buildSystem({ replyIntent: 'explain-delay' })).toMatch(/Do not invent a cause/i);
  });
});

describe('rewrite directives', () => {
  it('asks for a rewrite rather than a new answer', () => {
    const text = buildSystem({ refine: 'shorter' });
    expect(text).toMatch(/REWRITE REQUEST/i);
    expect(text).toMatch(/Rewrite ONLY the reply you are given/i);
  });

  it('differs per directive', () => {
    const texts = (['simpler', 'shorter', 'natural', 'formal'] as const).map((refine) =>
      buildSystem({ refine }),
    );
    expect(new Set(texts).size).toBe(4);
  });

  it('carries the previous reply in the user prompt, clearly marked as not speech', () => {
    const user = buildReplyUserPrompt({
      contextBlock: 'CURRENT UTTERANCE: """can you ship it friday"""',
      stage: 'refined',
      previousReply: "Let me check and confirm the date with you.",
    });
    expect(user).toContain('REPLY TO REWRITE');
    expect(user).toContain('not new speech');
    expect(user).toContain('Let me check and confirm the date with you.');
  });

  it('omits the rewrite block when there is nothing to rewrite', () => {
    const user = buildReplyUserPrompt({ contextBlock: 'ctx', stage: 'refined', previousReply: null });
    expect(user).not.toContain('REPLY TO REWRITE');
  });
});

describe('translation tone', () => {
  it('accepts every tone without silently falling back to professional', () => {
    const texts = ALL_TONES.map((tone) => buildTranslationSystemPrompt({ tone }));
    expect(new Set(texts).size).toBe(ALL_TONES.length);
    for (const text of texts) expect(text).toContain('Target tone:');
  });
});

describe('reply request validation', () => {
  it('accepts the full new contract', () => {
    const parsed = replyRequestSchema.parse({
      stage: 'refined',
      version: 3,
      utterance: 'Can you confirm the release date?',
      tone: 'diplomatic',
      replyIntent: 'confirm',
      refine: 'formal',
      previousReply: 'I will confirm the date.',
    });

    expect(parsed.tone).toBe('diplomatic');
    expect(parsed.replyIntent).toBe('confirm');
    expect(parsed.refine).toBe('formal');
  });

  it('defaults intent and refine to null instead of inventing a value', () => {
    const parsed = replyRequestSchema.parse({
      stage: 'refined',
      version: 1,
      utterance: 'hello there',
    });
    expect(parsed.replyIntent).toBeNull();
    expect(parsed.refine).toBeNull();
    expect(parsed.previousReply).toBeNull();
  });

  it('rejects an unknown tone', () => {
    const result = replyRequestSchema.safeParse({
      stage: 'refined',
      version: 1,
      utterance: 'hi there',
      tone: 'sarcastic',
    });
    expect(result.success).toBe(false);
  });
});

describe('POST /reply carries the controls into the prompt', () => {
  function appWithMock() {
    const client = new RecordingAiClient();
    const { app } = createApp({
      config: testConfig(),
      overrides: { aiClient: client },
    });
    return { app, client };
  }

  it('sends the selected tone and intent to the model', async () => {
    const { app, client } = appWithMock();
    const session = await request(app).post('/api/sessions').send({});

    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({
        stage: 'refined',
        version: 1,
        utterance: 'Why is the build failing again?',
        tone: 'empathetic',
        replyIntent: 'explain-delay',
      });

    expect(response.status).toBe(200);
    const system = client.calls[0]?.system ?? '';
    expect(system).toMatch(/show you understand how the other person is affected/i);
    expect(system).toMatch(/INTENT: explain a delay honestly/i);
  });

  it('includes the previous reply when rewriting', async () => {
    const { app, client } = appWithMock();
    const session = await request(app).post('/api/sessions').send({});

    const response = await request(app)
      .post(`/api/sessions/${session.body.id}/reply`)
      .send({
        stage: 'refined',
        version: 2,
        utterance: 'When will it be fixed?',
        tone: 'concise',
        refine: 'shorter',
        previousReply: 'I will check with the team and come back to you shortly.',
      });

    expect(response.status).toBe(200);
    const user = client.calls[0]?.user ?? '';
    expect(user).toContain('REPLY TO REWRITE');
    expect(user).toContain('I will check with the team and come back to you shortly.');
    const system = client.calls[0]?.system ?? '';
    expect(system).toMatch(/Make the reply shorter/i);
  });
});
