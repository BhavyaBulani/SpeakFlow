import type { RealtimeTokenResponse } from '../../shared/types';
import { ApiError } from '../lib/http';
import { logger } from '../lib/logger';
import { isRealtimeConfigured } from '../config';
import type { Services } from './index';

/**
 * Mints a short-lived Realtime client secret for the browser.
 *
 * The browser then opens WebRTC directly to the provider: audio never passes
 * through this server, which is what keeps transcription latency low. The
 * permanent API key never leaves this process.
 */
export async function createRealtimeToken(
  services: Services,
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<RealtimeTokenResponse> {
  const { config } = services;

  if (!isRealtimeConfigured(config)) {
    throw new ApiError('PROVIDER_NOT_CONFIGURED', {
      message:
        'Live streaming transcription needs OPENAI_API_KEY on the server. You can still use Browser speech or the Demo transcript.',
    });
  }

  const startedAt = Date.now();
  const token = await services.ai.createTranscriptionToken({
    model: config.transcribeModel,
    language: options.language ?? config.transcribeLanguage,
    silenceDurationMs: config.realtimeSilenceMs,
    ttlSeconds: config.realtimeTokenTtlSeconds,
    signal: options.signal,
  });

  logger.info('realtime.token_issued', {
    model: token.model,
    ms: Date.now() - startedAt,
    ttlSeconds: config.realtimeTokenTtlSeconds,
  });

  return {
    token: token.token,
    expiresAt: token.expiresAt,
    model: token.model,
    transport: {
      kind: 'webrtc',
      sdpUrl: token.sdpUrl,
      dataChannel: 'oai-events',
      inputFormat: 'pcm16',
      sampleRate: token.sampleRate,
    },
  };
}
