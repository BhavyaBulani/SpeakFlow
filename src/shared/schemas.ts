import { z } from 'zod';

/**
 * Validation schemas. Two jobs:
 *  1. reject bad input before it reaches an AI provider (cost + abuse guard)
 *  2. reject bad model output instead of rendering it as a script
 *
 * The JSON Schema handed to OpenAI's Structured Outputs is written by hand in
 * `REPLY_JSON_SCHEMA` / `TRANSLATION_JSON_SCHEMA` rather than generated, because
 * Structured Outputs requires every property listed in `required` and
 * `additionalProperties: false` on every object - easier to read explicitly.
 */

export const MAX_TRANSCRIPT_CHARS = 8000;
export const MAX_TRANSLATE_CHARS = 2000;

export const replyStageSchema = z.enum(['provisional', 'refined']);
export const confidenceSchema = z.enum(['low', 'medium', 'high']);
export const clientIntentSchema = z.enum([
  'question',
  'request',
  'feedback',
  'statement',
  'smalltalk',
  'unclear',
]);
export const replyToneSchema = z.enum([
  'professional',
  'friendly',
  'concise',
  'confident',
  'diplomatic',
  'empathetic',
]);

export const replyIntentSchema = z.enum([
  'answer',
  'clarify',
  'ask-for-time',
  'acknowledge',
  'disagree-politely',
  'negotiate',
  'explain-delay',
  'confirm',
]);

export const refineDirectiveSchema = z.enum(['simpler', 'shorter', 'natural', 'formal']);

/** The exact shape we ask the model for (snake_case, as in the spec). */
export const replyModelOutputSchema = z.object({
  suggested_reply: z.string().min(1).max(600),
  alternative_reply: z.string().max(600).nullable(),
  needs_clarification: z.boolean(),
  facts_to_verify: z.array(z.string().max(200)).max(5),
  confidence: confidenceSchema,
  intent: clientIntentSchema,
});

export type ReplyModelOutput = z.infer<typeof replyModelOutputSchema>;

export const REPLY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'suggested_reply',
    'alternative_reply',
    'needs_clarification',
    'facts_to_verify',
    'confidence',
    'intent',
  ],
  properties: {
    suggested_reply: {
      type: 'string',
      description:
        'One or two short sentences of natural spoken English the user can say out loud right now. Simple vocabulary, no filler, no fabricated facts.',
    },
    alternative_reply: {
      type: ['string', 'null'],
      description: 'A differently-worded alternative of similar meaning, or null if not useful.',
    },
    needs_clarification: {
      type: 'boolean',
      description: 'True when the safe response should ask a clarifying question instead of answering.',
    },
    facts_to_verify: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string' },
      description:
        'Concrete facts the user must confirm before stating them (e.g. "actual reason for the delay"). Empty when nothing needs checking.',
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Confidence that the interpretation of the client statement is correct. Not a claim of factual accuracy.',
    },
    intent: {
      type: 'string',
      enum: ['question', 'request', 'feedback', 'statement', 'smalltalk', 'unclear'],
    },
  },
} as const;

export const replyRequestSchema = z.object({
  stage: replyStageSchema,
  /** Client-side monotonic counter; echoed back so stale replies can be dropped. */
  version: z.number().int().min(0).max(1_000_000),
  /** The utterance currently being spoken (may be partial). */
  utterance: z.string().min(1).max(MAX_TRANSCRIPT_CHARS),
  /** Recent finalized utterances, oldest first. */
  recentFinals: z.array(z.string().max(MAX_TRANSCRIPT_CHARS)).max(12).default([]),
  tone: replyToneSchema.default('professional'),
  /** Optional explicit response intent the user selected. */
  replyIntent: replyIntentSchema.nullable().default(null),
  /** Optional one-click rewrite of the current script. */
  refine: refineDirectiveSchema.nullable().default(null),
  /** The script being rewritten. Required when `refine` is set. */
  previousReply: z.string().max(600).nullable().default(null),
  /** Free-form note the user typed about their own situation (never required). */
  userContext: z.string().max(1000).default(''),
  /** True when the utterance appears grammatically unfinished. */
  utteranceUnfinished: z.boolean().default(false),
});

export type ReplyRequest = z.infer<typeof replyRequestSchema>;

export const translateRequestSchema = z.object({
  text: z.string().min(1).max(MAX_TRANSLATE_CHARS),
  targetTone: replyToneSchema.default('professional'),
  sourceLanguage: z.enum(['auto', 'hi', 'hinglish', 'en']).default('auto'),
});

export type TranslateRequestInput = z.infer<typeof translateRequestSchema>;

export const translationModelOutputSchema = z.object({
  english: z.string().min(1).max(800),
  alternatives: z.array(z.string().max(800)).max(3),
  notes: z.string().max(400).nullable(),
  tone: replyToneSchema,
});

export const TRANSLATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['english', 'alternatives', 'notes', 'tone'],
  properties: {
    english: {
      type: 'string',
      description:
        'Natural, polite spoken English the user can say out loud. Same meaning, same strength of claim, simple vocabulary.',
    },
    alternatives: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string' },
      description: 'Up to 3 alternative phrasings. Empty array if not useful.',
    },
    notes: {
      type: ['string', 'null'],
      description:
        'Short note if the original intent was softened or clarified, or null. Never invent extra meaning.',
    },
    tone: {
      type: 'string',
      enum: ['professional', 'friendly', 'concise', 'confident', 'diplomatic', 'empathetic'],
    },
  },
} as const;

export const vocabularyCreateSchema = z.object({
  term: z.string().min(1).max(120),
  meaningEn: z.string().min(1).max(400),
  meaningHi: z.string().max(400).nullable().default(null),
  example: z.string().max(400).nullable().default(null),
});

export const sessionCreateSchema = z.object({
  /** Client-generated label; never contains transcript content. */
  label: z.string().max(80).optional(),
  saveTranscript: z.boolean().default(false),
});

export const realtimeTokenRequestSchema = z.object({
  /** Language hint for transcription; defaults from server config. */
  language: z.string().min(2).max(8).optional(),
});

/**
 * One chunk of audio for the chunked (HTTP) transcription route.
 *
 * The cap is deliberately generous for the length but hard: a 10 s chunk at
 * 16 kHz mono 16-bit is ~320 KB of audio, which is ~427 KB of base64. Anything
 * larger is either a mis-set STT_CHUNK_MS or someone posting a file.
 */
export const MAX_AUDIO_BASE64_CHARS = 512_000;

export const sttChunkRequestSchema = z.object({
  sessionId: z.string().min(8).max(64),
  /** Monotonic per-session frame number, echoed back for ordering checks. */
  seq: z.number().int().min(0).max(10_000_000),
  startSample: z.number().int().min(0),
  /** A complete 16 kHz mono 16-bit WAV file, base64 encoded. */
  wavBase64: z.string().min(1).max(MAX_AUDIO_BASE64_CHARS),
  language: z.string().min(2).max(8).optional(),
});

/** Response schemas - the client parses API output through these. */
export const replyResultSchema = z.object({
  version: z.number().int(),
  stage: replyStageSchema,
  suggestedReply: z.string(),
  alternativeReply: z.string().nullable(),
  needsClarification: z.boolean(),
  factsToVerify: z.array(z.string()),
  confidence: confidenceSchema,
  intent: clientIntentSchema,
  engine: z.enum([
    'openai',
    'groq',
    'openai-compatible',
    'local',
    'mock',
    'local_library',
    'safe_fallback',
  ]),
  model: z.string(),
  latencyMs: z.number(),
  receivedAt: z.number(),
  forUtterance: z.string(),
  notice: z.string().nullable(),
});

export const translateResultSchema = z.object({
  english: z.string(),
  alternatives: z.array(z.string()),
  notes: z.string().nullable(),
  tone: replyToneSchema,
  engine: z.enum([
    'openai',
    'groq',
    'openai-compatible',
    'local',
    'mock',
    'local_library',
    'safe_fallback',
  ]),
  model: z.string(),
  latencyMs: z.number(),
  notice: z.string().nullable(),
});
