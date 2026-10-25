import type { RequestHandler } from 'express';
import { ApiError } from './http';

/**
 * Fixed-window in-memory rate limiter.
 *
 * One instance per bucket. In-memory is deliberate: SpeakFlow runs as a single
 * backend instance, and the limiter is a cost guard rather than an accounting
 * system. Documented in README (swap for Redis when scaling horizontally).
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Label shown in the 429 message, e.g. "reply requests". */
  label?: string;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly options: RateLimitOptions) {}

  /** Exposed so tests can assert behaviour without waiting for real time. */
  check(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
    this.sweep(now);
    const existing = this.buckets.get(key);
    if (existing === undefined || now >= existing.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return { allowed: true, remaining: this.options.max - 1, retryAfterMs: 0 };
    }
    if (existing.count >= this.options.max) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, existing.resetAt - now) };
    }
    existing.count += 1;
    return { allowed: true, remaining: this.options.max - existing.count, retryAfterMs: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      const forwarded = req.headers['x-forwarded-for'];
      const ip =
        (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ??
        req.ip ??
        'unknown';
      // Authenticated workspaces get their own bucket so one user cannot
      // exhaust another's budget behind the same NAT/proxy IP.
      const identity = (req.headers.authorization ?? '').slice(-16);
      const result = this.check(ip + identity);

      res.setHeader('X-RateLimit-Limit', String(this.options.max));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));

      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
        next(
          new ApiError('RATE_LIMITED', {
            status: 429,
            message: `Too many ${this.options.label ?? 'requests'}. Please wait a moment and try again.`,
          }),
        );
        return;
      }
      next();
    };
  }
}
