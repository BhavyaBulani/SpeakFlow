import { TRANSLATION_JSON_SCHEMA, translationModelOutputSchema } from '../../shared/schemas';
import type { ReplyTone, TranslateResult } from '../../shared/types';
import { ApiError } from '../lib/http';
import { logger } from '../lib/logger';
import type { Services } from './index';
import { buildTranslationSystemPrompt, buildTranslationUserPrompt } from './prompts';

/**
 * Hindi / Hinglish / rough-English -> natural spoken English.
 *
 * The prompt forbids strengthening a claim ("fix kar diya" must not become
 * "fixed and tested"). A translation that cannot be validated returns a
 * labelled safe_fallback instead of invented English.
 */
export interface TranslateInput {
  text: string;
  targetTone: ReplyTone;
  sourceLanguage: 'auto' | 'hi' | 'hinglish' | 'en';
  signal?: AbortSignal;
}

export async function translateToEnglish(
  services: Services,
  input: TranslateInput,
): Promise<TranslateResult> {
  const startedAt = Date.now();
  const text = input.text.trim();
  if (text.length === 0) {
    throw new ApiError('VALIDATION_FAILED', { message: 'There was no text to translate.' });
  }

  if (services.breaker.isOpen()) {
    throw new ApiError('AI_UPSTREAM_ERROR', {
      message: 'The AI provider is not responding right now. Please try again in a few seconds.',
    });
  }

  // Same daily cap as replies: translation is a provider call and spends the
  // same allowance. Unlike a reply there is no holding line to fall back to, so
  // this reports the cap instead of inventing one.
  const budget = await services.budget.tryConsume();
  if (!budget.allowed) {
    logger.warn('translate.budget_exhausted', {
      limit: budget.state.limit,
      used: budget.state.used,
      store: budget.state.store,
    });
    throw new ApiError('AI_BUDGET_EXHAUSTED');
  }

  try {
    const result = await services.ai.structuredCompletion({
      model: services.config.aiModel,
      system: buildTranslationSystemPrompt({ tone: input.targetTone }),
      user: buildTranslationUserPrompt({ text, sourceLanguage: input.sourceLanguage }),
      schemaName: 'speakflow_translation',
      schema: TRANSLATION_JSON_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.2,
      maxOutputTokens: 400,
      signal: input.signal,
      variant: 'translation',
    });

    services.breaker.recordSuccess();

    const validated = translationModelOutputSchema.safeParse(JSON.parse(result.raw) as unknown);
    if (!validated.success) {
      logger.warn('translate.schema_mismatch', {
        issues: validated.error.issues.map((issue) => issue.path.join('.')).join(','),
      });
      throw new ApiError('AI_INVALID_OUTPUT', {
        message: 'The translation came back in an unexpected format. Please try again.',
      });
    }

    logger.info('translate.generated', {
      engine: services.ai.id,
      totalMs: Date.now() - startedAt,
      sourceChars: text.length,
      sourceLanguage: input.sourceLanguage,
    });

    return {
      english: validated.data.english.trim(),
      alternatives: validated.data.alternatives.map((item) => item.trim()).filter(Boolean),
      notes: validated.data.notes?.trim() || null,
      tone: validated.data.tone,
      engine: services.ai.id,
      model: result.model,
      latencyMs: Date.now() - startedAt,
      notice: null,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code !== 'AI_INVALID_OUTPUT') services.breaker.recordFailure();
      throw error;
    }
    if (error instanceof SyntaxError) {
      services.breaker.recordFailure();
      throw new ApiError('AI_INVALID_OUTPUT', {
        message: 'The translation came back in an unexpected format. Please try again.',
      });
    }
    services.breaker.recordFailure();
    logger.error('translate.failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ApiError('AI_UPSTREAM_ERROR');
  }
}
