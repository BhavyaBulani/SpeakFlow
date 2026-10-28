import { randomUUID } from 'node:crypto';
import type { SessionInfo } from '../../shared/types';

/**
 * Call-session metadata store.
 *
 * Privacy decision (spec section 7): transcripts are never persisted. This
 * store only holds metadata - the conversation itself lives in browser memory
 * and in the request payloads. Deleting a session removes the metadata
 * immediately; it is also swept automatically after `ttlMinutes`.
 *
 * The interface is async even though the in-memory implementation is not: the
 * Postgres implementation is the reason, and a sync interface would have forced
 * a second, divergent code path in the routes.
 */

export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastActivityAt: number;
  label: string | null;
  /** Always false. Present so the API can state it explicitly. */
  transcriptPersisted: false;
}

export interface SessionStore {
  /** Reported by /api/health so the operator can see which store is live. */
  readonly kind: 'memory' | 'postgres';
  create(label?: string): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | null>;
  touch(id: string): Promise<void>;
  /** Extends a session's lifetime - called while a call is genuinely active. */
  refresh(id: string): Promise<SessionRecord | null>;
  delete(id: string): Promise<boolean>;
  sweep(): Promise<number>;
  /** Live (unexpired) session count. */
  count(): Promise<number>;
  /** Releases pooled connections. No-op for memory. */
  close(): Promise<void>;
}

export function toSessionInfo(record: SessionRecord): SessionInfo {
  return {
    id: record.id,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    transcriptPersisted: false,
  };
}

/** Single-process store. The default, and what the tests and `npm run dev` use. */
export class MemorySessionStore implements SessionStore {
  readonly kind = 'memory';
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly options: {
      ttlMinutes: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async create(label?: string): Promise<SessionRecord> {
    this.sweepSync();
    const now = this.now();
    const record: SessionRecord = {
      id: randomUUID(),
      createdAt: now,
      expiresAt: now + this.options.ttlMinutes * 60_000,
      lastActivityAt: now,
      label: label ?? null,
      transcriptPersisted: false,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    if (record.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return record;
  }

  async touch(id: string): Promise<void> {
    const record = this.sessions.get(id);
    if (record === undefined) return;
    record.lastActivityAt = this.now();
    record.expiresAt = record.lastActivityAt + this.options.ttlMinutes * 60_000;
  }

  async refresh(id: string): Promise<SessionRecord | null> {
    await this.touch(id);
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async sweep(): Promise<number> {
    return this.sweepSync();
  }

  private sweepSync(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, record] of this.sessions) {
      if (record.expiresAt <= now) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async count(): Promise<number> {
    const now = this.now();
    let live = 0;
    for (const record of this.sessions.values()) {
      if (record.expiresAt > now) live += 1;
    }
    return live;
  }

  async close(): Promise<void> {
    this.sessions.clear();
  }
}
