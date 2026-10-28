import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { deriveConfig, type ServerConfig } from './config';
import { requireAccessToken } from './lib/auth';
import { ApiError, errorHandler, notFoundHandler } from './lib/http';
import { logger } from './lib/logger';
import { RateLimiter } from './lib/rateLimit';
import { configRouter, healthRouter } from './routes/health';
import { realtimeRouter } from './routes/realtime';
import { sessionsRouter } from './routes/sessions';
import { sttRouter } from './routes/stt';
import { translateRouter } from './routes/translate';
import { vocabularyRouter } from './routes/vocabulary';
import { createServices, type ServiceOverrides, type Services } from './services';

/**
 * Builds the Express application.
 *
 * Kept free of `app.listen` and of `process.env` side effects so that tests can
 * construct an app around an explicit config and a mock AI client.
 */
export interface AppBundle {
  app: Express;
  services: Services;
}

export interface CreateAppOptions {
  config?: ServerConfig;
  overrides?: ServiceOverrides;
  /**
   * Serve the built SPA from this process. Defaults to on, which is what the
   * single-service Render deployment wants. A serverless host serves the client
   * from its own CDN, so it turns this off rather than shipping HTML inside the
   * function bundle.
   */
  serveStatic?: boolean;
}

export function createApp(options: CreateAppOptions = {}): AppBundle {
  const config = options.config ?? deriveConfig();
  const services = createServices(config, options.overrides);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Correlation id for logs; also returned so a user can quote it in a report.
  app.use((req, res, next) => {
    const requestId = randomUUID().slice(0, 8);
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });

  // Baseline security headers (helmet-equivalent for the few we need).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(
      'Permissions-Policy',
      'microphone=(self), display-capture=(self), camera=(), geolocation=()',
    );
    next();
  });

  const allowedOrigins = new Set(config.corsOrigins);

  /**
   * CORS allowlist.
   *
   * Hand-written rather than the `cors` package because of a subtlety that broke
   * the app once: browsers send an `Origin` header on CORS-mode requests, which
   * includes ES module scripts and stylesheets. A same-origin page therefore
   * sends `Origin: <its own origin>`, and if that origin is not in the allowlist
   * the bundle itself gets rejected and the SPA never mounts.
   *
   * So: an origin equal to the request's OWN host is always allowed (it is the
   * same site, by definition), and the allowlist governs only genuine
   * cross-origin API access.
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // No Origin header: same-origin navigation, curl, or a server-to-server call.
    if (origin === undefined || origin === '') {
      next();
      return;
    }

    const selfOrigin = `${req.protocol}://${req.get('host') ?? ''}`;
    const isSameOrigin = origin === selfOrigin;
    const isAllowlisted = allowedOrigins.has(origin);

    if (!isSameOrigin && !isAllowlisted) {
      next(
        new ApiError('UNAUTHORIZED', {
          status: 403,
          message:
            'This origin is not allowed to call the API. Add it to CORS_ORIGINS on the server.',
        }),
      );
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Id');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  // 256kb is comfortably above a transcript payload and well below abuse.
  app.use(express.json({ limit: '256kb' }));

  const generalLimiter = new RateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    label: 'requests',
  });
  const aiLimiter = new RateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.aiRateLimitMax,
    label: 'AI requests',
  });

  const api = express.Router();
  api.use(generalLimiter.middleware());

  // Public: uptime checks and capability advert.
  api.use('/health', healthRouter(services));
  api.use('/config', configRouter(services));

  // Everything below is gated when APP_ACCESS_TOKEN is configured.
  api.use(requireAccessToken(config.accessToken));

  // Tighter bucket for the expensive routes only.
  api.use('/sessions/:id/reply', aiLimiter.middleware());
  api.use('/sessions', sessionsRouter(services));
  api.use('/translate', aiLimiter.middleware(), translateRouter(services));
  api.use('/realtime', aiLimiter.middleware(), realtimeRouter(services));
  // Chunked STT costs provider quota per request, so it shares the tight bucket.
  api.use('/stt', aiLimiter.middleware(), sttRouter(services));
  api.use('/vocabulary', vocabularyRouter(services));

  api.use(notFoundHandler);

  app.use('/api', api);

  // In production this server also serves the built SPA, so a single Render
  // service can host the whole app. Vercel-only deployments skip this branch.
  const clientDir = path.resolve(process.cwd(), 'dist', 'client');
  const indexHtml = path.join(clientDir, 'index.html');
  if (options.serveStatic !== false && existsSync(indexHtml)) {
    app.use(
      express.static(clientDir, {
        index: false,
        setHeaders(res, filePath) {
          if (/\.(js|css|woff2?|svg|png|webp)$/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
    logger.debug('app.static_enabled', { clientDir });
  }

  app.use(notFoundHandler);
  app.use(errorHandler());

  return { app, services };
}
