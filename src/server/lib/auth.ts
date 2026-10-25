import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from './http';

/**
 * Optional workspace gate.
 *
 * When `APP_ACCESS_TOKEN` is set, every API route except the two public ones
 * requires `Authorization: Bearer <token>`. This is a shared-secret gate for a
 * single-workspace deployment - NOT per-user authentication. It exists so a
 * deployed instance is not open to the internet by default, and so a
 * Supabase/JWT verifier can drop into the same slot later.
 */
export function requireAccessToken(accessToken: string | null): RequestHandler {
  if (accessToken === null) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const expected = Buffer.from(accessToken, 'utf8');

  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

    if (provided.length === 0) {
      next(new ApiError('UNAUTHORIZED', { status: 401 }));
      return;
    }

    const candidate = Buffer.from(provided, 'utf8');
    const sameLength = candidate.length === expected.length;
    // Compare in constant time; a length mismatch is still a rejection.
    if (!sameLength || !timingSafeEqual(candidate, expected)) {
      next(new ApiError('UNAUTHORIZED', { status: 401 }));
      return;
    }
    next();
  };
}

/**
 * Identity used to scope saved vocabulary. Deliberately a client-supplied id:
 * without real accounts there is exactly one workspace, so this only prevents
 * accidental cross-contamination between two browsers on the same server.
 */
export function resolveClientOwner(req: Request): string {
  const raw = req.headers['x-client-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return 'local-workspace';
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned.length === 0 ? 'local-workspace' : cleaned;
}
