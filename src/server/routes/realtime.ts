import { Router } from 'express';
import { realtimeTokenRequestSchema } from '../../shared/schemas';
import { asyncHandler } from '../lib/http';
import type { Services } from '../services';
import { createRealtimeToken } from '../services/realtimeTokens';

/**
 * Issues a short-lived Realtime client secret.
 *
 * This is the only place the permanent provider key is used for audio, and the
 * response deliberately contains no key material - just an ephemeral `ek_...`
 * token plus the WebRTC transport details.
 */
export function realtimeRouter(services: Services): Router {
  const router = Router();

  router.post(
    '/token',
    asyncHandler(async (req, res) => {
      const parsed = realtimeTokenRequestSchema.parse(req.body ?? {});

      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      const tokenResponse = await createRealtimeToken(services, {
        ...(parsed.language === undefined ? {} : { language: parsed.language }),
        signal: controller.signal,
      });

      // The token is a bearer credential for the provider: never cache it.
      res.setHeader('Cache-Control', 'no-store');
      res.json(tokenResponse);
    }),
  );

  return router;
}
