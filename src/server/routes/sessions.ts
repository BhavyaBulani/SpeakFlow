import { Router } from 'express';
import { replyRequestSchema, sessionCreateSchema } from '../../shared/schemas';
import { ApiError, asyncHandler, routeParam } from '../lib/http';
import { logger } from '../lib/logger';
import type { Services } from '../services';
import { generateReply } from '../services/replyEngine';

/**
 * Session lifecycle + the two-stage reply endpoint.
 *
 * `POST /:id/reply` is the hot path: it is called while the client is still
 * talking. It aborts the upstream AI request as soon as the browser cancels
 * (because newer speech arrived), so cancelled work stops being billed.
 */
export function sessionsRouter(services: Services): Router {
  const router = Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = sessionCreateSchema.parse(req.body ?? {});
      if (parsed.saveTranscript) {
        // Explicit, honest refusal rather than silently ignoring the request.
        throw new ApiError('VALIDATION_FAILED', {
          message:
            'Transcript saving is not available: SpeakFlow keeps transcripts in memory only. See Privacy in the README.',
        });
      }
      const record = services.sessions.create(parsed.label);
      logger.info('session.created', { sessionId: record.id });
      res.status(201).json(services.sessions.toInfo(record));
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = routeParam(req, 'id');
      const removed = services.sessions.delete(id);
      if (!removed) throw new ApiError('SESSION_NOT_FOUND');
      logger.info('session.deleted', { sessionId: id });
      res.status(204).end();
    }),
  );

  router.post(
    '/:id/reply',
    asyncHandler(async (req, res) => {
      const startedAt = Date.now();
      const input = replyRequestSchema.parse(req.body ?? {});
      const session = services.sessions.refresh(routeParam(req, 'id'));
      if (session === null) throw new ApiError('SESSION_NOT_FOUND');

      // Abort upstream work when the browser goes away (superseded request).
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      const result = await generateReply(services, {
        version: input.version,
        stage: input.stage,
        utterance: input.utterance,
        recentFinals: input.recentFinals,
        tone: input.tone,
        replyIntent: input.replyIntent,
        refine: input.refine,
        previousReply: input.previousReply,
        userContext: input.userContext,
        utteranceUnfinished: input.utteranceUnfinished,
        signal: controller.signal,
      });

      logger.info('reply.served', {
        sessionId: session.id,
        stage: input.stage,
        version: input.version,
        engine: result.engine,
        ms: Date.now() - startedAt,
      });

      res.json(result);
    }),
  );

  return router;
}
