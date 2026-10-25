import { randomUUID } from 'node:crypto';
import type { SessionInfo } from '../../shared/types';

/**
 * In-memory call-session store.
 *
 * Privacy decision (spec section 7): transcripts are never persisted. This
 * store only holds metadata - the conversation itself lives in browser memory
 * and in the request payloads. Deleting a session removes the metadata
 * immediately; it is also swept automatically after `ttlMinutes`.
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

export class SessionStore {
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

  create(label?: string): SessionRecord {
    this.sweep();
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

  get(id: string): SessionRecord | null {
    const record = this.sessions.get(id);
    if (record === undefined) return null;
    if (record.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return record;
  }

  touch(id: string): void {
    const record = this.sessions.get(id);
    if (record === undefined) return;
    record.lastActivityAt = this.now();
    record.expiresAt = record.lastActivityAt + this.options.ttlMinutes * 60_000;
  }

  /** Extends a session's lifetime - called while a call is genuinely active. */
  refresh(id: string): SessionRecord | null {
    this.touch(id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  sweep(): number {
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

  get size(): number {
    return this.sessions.size;
  }

  toInfo(record: SessionRecord): SessionInfo {
    return {
      id: record.id,
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
      transcriptPersisted: false,
    };
  }
}
