import { REPLY_JSON_SCHEMA, replyModelOutputSchema } from '../../shared/schemas';
import { matchFastPath } from '../../shared/responseLibrary';
import { composeContextBlock, looksUnfinished, trimToChars, wordCount } from '../../shared/transcript';
import type { RefineDirective, ReplyIntent, ReplyResult, ReplyStage, ReplyTone } from '../../shared/types';
import { ApiError } from '../lib/http';
import { logger } from '../lib/logger';
import type { Services } from './index';
import { buildReplySystemPrompt, buildReplyUserPrompt, safeFallbackReply } from './prompts';

/**
 * Generates a provisional or refined spoken-English reply.
 *
 * Failure policy (deliberate, and documented in the README):
 *  - provider not configured  -> throw 503. Nothing is faked.
 *  - request cancelled        -> throw, the client already moved on.
 *  - anything else (timeout, rate limit, 5xx, unvalidatable output)
 *      -> return a labelled `safe_fallback` reply with a `notice`, because on a
 *         live call a safe holding line beats an error box.
 */

export interface ReplyEngineInput {
  version: number;
  stage: ReplyStage;
  utterance: string;
  recentFinals: string[];
  tone: ReplyTone;
  userContext: string;
  utteranceUnfinished: boolean;
  /** Optional explicit response intent selected by the user. */
  replyIntent?: ReplyIntent | null;
  /** Optional one-click rewrite of the script already on screen. */
  refine?: RefineDirective | null;
  previousReply?: string | null;
  signal?: AbortSignal;
}

const TEMPERATURE = 0.3;
const MAX_OUTPUT_TOKENS = 400;

function buildFallback(
  input: ReplyEngineInput,
  startedAt: number,
  notice: string,
): ReplyResult {
  const needsClarification = wordCount(input.utterance) <= 3;
  const fallback = safeFallbackReply(input.stage, needsClarification);
  return {
    version: input.version,
    stage: input.stage,
    suggestedReply: fallback.suggestedReply,
    alternativeReply: fallback.alternativeReply,
    needsClarification: fallback.needsClarification,
    factsToVerify: fallback.factsToVerify,
    confidence: fallback.confidence,
    intent: 'unclear',
    engine: 'safe_fallback',
    model: 'none',
    latencyMs: Date.now() - startedAt,
    receivedAt: Date.now(),
    forUtterance: input.utterance,
    notice,
  };
}

function buildFromLibrary(
  input: ReplyEngineInput,
  match: ReturnType<typeof matchFastPath>,
  startedAt: number,
): ReplyResult {
  // match is non-null by construction at the call site; this guard keeps the
  // types honest without inventing a fallback string.
  if (match === null) throw new Error('buildFromLibrary called without a match');

  return {
    version: input.version,
    stage: input.stage,
    suggestedReply: match.reply,
    alternativeReply: match.alternative,
    needsClarification: match.needsClarification,
    factsToVerify: [],
    confidence: 'medium',
    intent: 'unclear',
    engine: 'local_library',
    model: 'response-library',
    latencyMs: Date.now() - startedAt,
    receivedAt: Date.now(),
    forUtterance: input.utterance,
    // Explicit, because the spec forbids presenting a template as fresh AI
    // output. The UI badges this and the notice says so in plain language.
    notice: null,
  };
}

export async function generateReply(
  services: Services,
  input: ReplyEngineInput,
): Promise<ReplyResult> {
  const startedAt = Date.now();
  const { config } = services;

  const utterance = trimToChars(input.utterance, config.maxTranscriptChars).trim();
  if (utterance.length === 0) {
    throw new ApiError('VALIDATION_FAILED', { message: 'The current utterance was empty.' });
  }

  const recentFinals = input.recentFinals
    .slice(-config.contextWindowTurns)
    .map((line) => trimToChars(line, config.maxTranscriptChars / 2));

  const utteranceUnfinished =
    input.stage === 'provisional' ? input.utteranceUnfinished || looksUnfinished(utterance) : false;

  const contextBlock = composeContextBlock({
    recentFinals,
    utterance,
    maxChars: config.maxTranscriptChars,
    utteranceUnfinished,
  });

  if (services.breaker.isOpen()) {
    logger.warn('reply.breaker_open', { stage: input.stage });
    return buildFallback(
      input,
      startedAt,
      'The AI provider is not responding right now. This is a safe holding line, not AI output.',
    );
  }

  /*
   * Local fast path.
   *
   * Provisional replies are the most frequently repeated request in the app and
   * a partial sentence can never justify a factual answer - so a holding or
   * clarifying template is not a degraded reply, it is the right one. This also
   * keeps the product usable at ₹0 and when a quota is exhausted.
   *
   * Skipped when the user pinned an explicit intent (a template cannot honour
   * "negotiate this" reliably) or when rewriting a reply they already have.
   */
  if (
    input.stage === 'provisional' &&
    config.fastPathEnabled &&
    (input.replyIntent === undefined || input.replyIntent === null) &&
    (input.refine === undefined || input.refine === null)
  ) {
    const match = matchFastPath(utterance, input.tone);
    if (match !== null) {
      logger.info('reply.fast_path_hit', {
        record: match.record.id,
        score: match.score,
        ms: Date.now() - startedAt,
      });
      return buildFromLibrary(input, match, startedAt);
    }
  }

  let raw: string;
  let model: string;
  let providerLatency: number;
  let usage: { promptTokens: number; completionTokens: number } | null;

  try {
    const result = await services.ai.structuredCompletion({
      model: config.aiModel,
      system: buildReplySystemPrompt({
        stage: input.stage,
        tone: input.tone,
        utteranceUnfinished,
        userContext: input.userContext,
        replyIntent: input.replyIntent ?? null,
        refine: input.refine ?? null,
      }),
      user: buildReplyUserPrompt({
        contextBlock,
        stage: input.stage,
        previousReply: input.previousReply ?? null,
      }),
      schemaName: 'speakflow_reply',
      schema: REPLY_JSON_SCHEMA as unknown as Record<string, unknown>,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      signal: input.signal,
      variant: input.stage,
    });
    raw = result.raw;
    model = result.model;
    providerLatency = result.latencyMs;
    usage = result.usage;
    services.breaker.recordSuccess();
  } catch (error) {
    if (error instanceof ApiError) {
      // These two are not provider failures - never paper over them.
      if (error.code === 'REQUEST_ABORTED' || error.code === 'PROVIDER_NOT_CONFIGURED') {
        throw error;
      }
      services.breaker.recordFailure();
      logger.warn('reply.provider_failed', { stage: input.stage, code: error.code });
      return buildFallback(input, startedAt, `${error.message} Showing a safe holding line instead.`);
    }
    services.breaker.recordFailure();
    logger.error('reply.unknown_failure', {
      stage: input.stage,
      message: error instanceof Error ? error.message : String(error),
    });
    return buildFallback(
      input,
      startedAt,
      'The AI reply could not be generated. Showing a safe holding line instead.',
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    services.breaker.recordFailure();
    logger.warn('reply.invalid_json', { stage: input.stage });
    return buildFallback(
      input,
      startedAt,
      'The AI answer was not in the expected format, so a safe holding line is shown.',
    );
  }

  const validated = replyModelOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    services.breaker.recordFailure();
    logger.warn('reply.schema_mismatch', {
      stage: input.stage,
      issues: validated.error.issues.map((issue) => issue.path.join('.')).join(','),
    });
    return buildFallback(
      input,
      startedAt,
      'The AI answer failed validation, so a safe holding line is shown.',
    );
  }

  const output = validated.data;

  // Defence in depth: a model that ignores the "one or two short sentences"
  // rule must not produce an unreadable block in the middle of a call.
  const suggestedReply = output.suggested_reply.trim().slice(0, 600);

  logger.info('reply.generated', {
    stage: input.stage,
    engine: services.ai.id,
    model,
    providerLatencyMs: providerLatency,
    totalMs: Date.now() - startedAt,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    needsClarification: output.needs_clarification,
    confidence: output.confidence,
    utteranceWords: wordCount(utterance),
  });

  return {
    version: input.version,
    stage: input.stage,
    suggestedReply,
    alternativeReply: output.alternative_reply?.trim() || null,
    needsClarification: output.needs_clarification,
    factsToVerify: output.facts_to_verify.map((fact) => fact.trim()).filter((fact) => fact.length > 0),
    confidence: output.confidence,
    intent: output.intent,
    engine: services.ai.id,
    model,
    latencyMs: Date.now() - startedAt,
    receivedAt: Date.now(),
    forUtterance: utterance,
    notice: null,
  };
}
