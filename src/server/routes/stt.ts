import { Router } from 'express';
import { MAX_AUDIO_BASE64_CHARS, sttChunkRequestSchema } from '../../shared/schemas';
import { ApiError, asyncHandler } from '../lib/http';
import { logger } from '../lib/logger';
import type { Services } from '../services';
import { base64ToBytes } from '../services/stt';

/**
 * Chunked speech-to-text.
 *
 * The browser posts self-contained WAV chunks and gets text back per chunk.
 * This is NOT a streaming endpoint and the response says so (`mode: 'chunked'`)
 * so the UI cannot accidentally describe it as live partials.
 *
 * Privacy: the recognised text is returned to the caller and never logged. The
 * audio is held in memory for the duration of one provider request and dropped.
 */
export function sttRouter(services: Services): Router {
  const router = Router();

  /**
   * Per-session chunk counter.
   *
   * A live speaker can generate a chunk every couple of seconds; a runaway
   * client (or a stuck retry loop) could otherwise burn a whole free tier in
   * minutes. This is the hard stop, and it is per-session so one long call
   * cannot starve every other session.
   */
  const chunksBySession = new Map<string, number>();

  router.post(
    '/chunk',
    asyncHandler(async (req, res) => {
      const { config } = services;

      if (config.sttMode !== 'chunked') {
        throw new ApiError('VALIDATION_FAILED', {
          message:
            'This server is configured for realtime transcription, which does not accept audio chunks. Set STT_PROVIDER=openai-compatible to use this route.',
        });
      }

      const parsed = sttChunkRequestSchema.parse(req.body ?? {});

      // A chunk may only be transcribed for a session this server actually
      // created, which keeps the route from being used as a free STT proxy.
      const session = await services.sessions.get(parsed.sessionId);
      if (session === null) {
        throw new ApiError('SESSION_NOT_FOUND');
      }

      const used = chunksBySession.get(parsed.sessionId) ?? 0;
      if (used >= config.sttMaxRequestsPerSession) {
        throw new ApiError('AI_BUDGET_EXHAUSTED', {
          message: `This session has sent ${used} audio chunks, which is the configured limit (STT_MAX_REQUESTS_PER_SESSION). Transcription for this call has stopped; the transcript already captured is unaffected.`,
        });
      }

      const wav = base64ToBytes(parsed.wavBase64);
      if (wav.length < 44) {
        throw new ApiError('VALIDATION_FAILED', { message: 'Audio chunk was too short to contain a WAV file.' });
      }
      // Cheap structural check: every chunk must be a complete RIFF/WAVE file,
      // because a raw MediaRecorder slice after the first one is not decodable.
      const riff = String.fromCharCode(wav[0] ?? 0, wav[1] ?? 0, wav[2] ?? 0, wav[3] ?? 0);
      if (riff !== 'RIFF') {
        throw new ApiError('VALIDATION_FAILED', {
          message: 'Audio chunk is not a RIFF/WAVE file. Each chunk must be independently decodable.',
        });
      }

      chunksBySession.set(parsed.sessionId, used + 1);
      await services.sessions.touch(parsed.sessionId);

      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      const result = await services.stt.transcribe({
        wav,
        language: parsed.language ?? config.transcribeLanguage,
        signal: controller.signal,
      });

      // Content length only - never the transcript itself.
      logger.info('stt.chunk', {
        seq: parsed.seq,
        bytes: wav.length,
        providerMs: result.providerMs,
        chars: result.text.length,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        seq: parsed.seq,
        startSample: parsed.startSample,
        text: result.text,
        language: result.language,
        mode: result.mode,
        model: result.model,
        providerMs: result.providerMs,
        receivedAt: Date.now(),
        maxAudioChars: MAX_AUDIO_BASE64_CHARS,
      });
    }),
  );

  return router;
}
