import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp, type AppBundle } from './app';
import { deriveConfig } from './config';
import { logger } from './lib/logger';

/**
 * Serverless entry point.
 *
 * `src/server/index.ts` binds a port and installs process handlers, which is
 * exactly what a serverless host must not do. This module builds the same app
 * without either, and reuses it across invocations for the life of the
 * instance.
 *
 * Two things differ from the long-running server on purpose:
 *
 * 1. Static file serving is off: the host's CDN serves `dist/client`, so the
 *    function only ever answers `/api/*`.
 * 2. There is no sweeper interval. Expiry is enforced on read by the session
 *    store (`get()` treats an expired row as absent and deletes it), and a
 *    serverless instance must not leave timers behind.
 */

let cached: AppBundle | null = null;

/** Built once per instance. Exported so a test can exercise the real path. */
export function getServerlessApp(): AppBundle {
  if (cached === null) {
    const config = deriveConfig();
    cached = createApp({ config, serveStatic: false });

    logger.info('serverless.ready', {
      aiConfigured: config.aiProvider,
      replyModel: config.aiModel,
      sttProvider: config.sttProvider,
      sttModel: config.sttModel,
      sessionStore: config.databaseUrl === null ? 'memory' : 'postgres',
      authRequired: config.accessToken !== null,
    });

    if (config.databaseUrl === null) {
      // Not fatal, but it means sessions vanish between requests: a serverless
      // host may route the next call to a different instance. Said out loud
      // because the symptom (SESSION_NOT_FOUND on a live call) looks like a bug
      // in the client.
      logger.warn('serverless.no_database', {
        hint: 'DATABASE_URL is unset, so call sessions are held in this instance only and will not survive the next request. Set DATABASE_URL for any multi-instance deployment.',
      });
    }
    if (config.accessToken === null) {
      logger.warn('serverless.no_access_token', {
        hint: 'This deployment answers without authentication. Set APP_ACCESS_TOKEN before sharing the URL.',
      });
    }
  }
  return cached;
}

/** Resets the memoised app. Test-only. */
export function resetServerlessAppForTests(): void {
  cached = null;
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  getServerlessApp().app(req, res);
}
