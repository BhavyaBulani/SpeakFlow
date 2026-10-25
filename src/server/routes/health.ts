import { Router } from 'express';
import { toPublicAppConfig } from '../config';
import { asyncHandler } from '../lib/http';
import { providerStatus, type Services } from '../services';

/** Service health. Public (no auth) so uptime checks and the UI can poll it. */
export function healthRouter(services: Services): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({
        status: 'ok',
        version: services.config.appVersion,
        environment: services.config.nodeEnv,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        activeSessions: services.sessions.size,
        ...providerStatus(services),
        timestamp: new Date().toISOString(),
      });
    }),
  );

  return router;
}

/** Public capability advert so the UI never guesses what is configured. */
export function configRouter(services: Services): Router {
  const router = Router();
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(toPublicAppConfig(services.config));
    }),
  );
  return router;
}
