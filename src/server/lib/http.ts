import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { API_ERROR_MESSAGES, type ApiErrorCode } from '../../shared/errors';
import { logger } from './logger';

/** An error that is safe to serialise to the client. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, options: { status?: number; message?: string; details?: unknown } = {}) {
    super(options.message ?? API_ERROR_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details;
  }
}

function defaultStatus(code: ApiErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'NOT_FOUND':
    case 'SESSION_NOT_FOUND':
      return 404;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'RATE_LIMITED':
      return 429;
    case 'AI_RATE_LIMITED':
      return 429;
    // Quota exhaustion is a 429, not a server fault: retrying later is the fix,
    // and reporting 500 would make the UI blame the wrong thing.
    case 'AI_BUDGET_EXHAUSTED':
      return 429;
    case 'PROVIDER_NOT_CONFIGURED':
      return 503;
    case 'AI_TIMEOUT':
      return 504;
    case 'AI_UPSTREAM_ERROR':
      return 502;
    case 'REQUEST_ABORTED':
      return 499;
    default:
      return 500;
  }
}

/** Wrap an async route so rejections reach the error handler (Express 4). */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

/** Read a required route parameter, without the `string | undefined` dance. */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('VALIDATION_FAILED', { message: `Missing route parameter: ${name}` });
  }
  return value;
}

export function notFoundHandler(req: Request, res: Response): void {  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

/**
 * Terminal error handler. Never leaks stack traces or provider payloads: the
 * full error is logged server-side (with transcript fields redacted) and the
 * client receives a stable, human-readable message.
 */
export function errorHandler() {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = res.locals.requestId as string | undefined;

    if (err instanceof ApiError) {
      if (err.status >= 500) {
        logger.warn('request.failed', { requestId, code: err.code, path: req.path });
      }
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details, requestId },
      });
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the information sent was not valid.',
          details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          requestId,
        },
      });
      return;
    }

    const isJsonParseError =
      typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed';
    if (isJsonParseError) {
      res.status(400).json({
        error: { code: 'VALIDATION_FAILED', message: 'Request body was not valid JSON.', requestId },
      });
      return;
    }

    const isTooLarge =
      typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large';
    if (isTooLarge) {
      res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: API_ERROR_MESSAGES.PAYLOAD_TOO_LARGE, requestId },
      });
      return;
    }

    logger.error('request.unhandled', {
      requestId,
      path: req.path,
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : 'Unknown',
    });

    res.status(500).json({
      error: { code: 'INTERNAL', message: API_ERROR_MESSAGES.INTERNAL, requestId },
    });
  };
}
