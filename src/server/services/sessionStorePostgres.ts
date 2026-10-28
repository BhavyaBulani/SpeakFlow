import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger';
import type { SessionRecord, SessionStore } from './sessions';

/**
 * Postgres-backed session metadata.
 *
 * Required on any host where more than one process serves requests (serverless
 * especially, but also a Render cluster): a session created by one instance must
 * be visible to the next. See `ServerConfig.databaseUrl`.
 *
 * Only metadata is stored. Transcript text is never written here - that is the
 * privacy promise in the README, and the table has no column for it.
 */

/** The minimum of a `pg` Pool/Client that this store needs. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end?(): Promise<void>;
}

export interface PostgresSessionStoreOptions {
  ttlMinutes: number;
  queryable: Queryable;
  now?: () => number;
  /** Runs `CREATE TABLE IF NOT EXISTS` once, before the first query. */
  ensureSchema?: boolean;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS speakflow_sessions (
     id uuid PRIMARY KEY,
     created_at bigint NOT NULL,
     expires_at bigint NOT NULL,
     last_activity_at bigint NOT NULL,
     label text,
     transcript_persisted boolean NOT NULL DEFAULT false
   )`,
  `CREATE INDEX IF NOT EXISTS speakflow_sessions_expires_at_idx
     ON speakflow_sessions (expires_at)`,
];

/**
 * Session ids come from the URL (`/api/sessions/:id/reply`), so an arbitrary
 * string reaches these queries. Postgres rejects a non-UUID comparison with
 * `22P02 invalid input syntax for type uuid`, which would surface as a 500 for
 * what is really a malformed id. Reject it here and let the route answer 404.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function toNumber(value: unknown): number {
  // `pg` returns bigint columns as strings to avoid precision loss, so every
  // numeric field has to be coerced explicitly.
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'bigint') return Number(value);
  return Number.NaN;
}

function toRecord(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    createdAt: toNumber(row.created_at),
    expiresAt: toNumber(row.expires_at),
    lastActivityAt: toNumber(row.last_activity_at),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    transcriptPersisted: false,
  };
}

const COLUMNS = 'id, created_at, expires_at, last_activity_at, label';

export class PostgresSessionStore implements SessionStore {
  readonly kind = 'postgres';
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly options: PostgresSessionStoreOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private expiryFrom(now: number): number {
    return now + this.options.ttlMinutes * 60_000;
  }

  /**
   * Bootstrap is lazy and memoised rather than done in the constructor, so that
   * importing the module never performs I/O - which matters on a serverless
   * cold start, where the first request pays for it once, not per instance
   * creation during a build.
   */
  private async ensure(): Promise<void> {
    if (this.options.ensureSchema === false) return;
    if (this.schemaReady === null) {
      this.schemaReady = (async () => {
        for (const statement of SCHEMA_STATEMENTS) {
          await this.options.queryable.query(statement);
        }
        logger.info('session_store.schema_ready');
      })();
      // A failed bootstrap must not be cached forever: the next request retries,
      // which is what an operator sees after fixing DATABASE_URL.
      this.schemaReady = this.schemaReady.catch((error: unknown) => {
        this.schemaReady = null;
        throw error;
      });
    }
    await this.schemaReady;
  }

  async create(label?: string): Promise<SessionRecord> {
    await this.ensure();
    const now = this.now();
    const record: SessionRecord = {
      id: randomUUID(),
      createdAt: now,
      expiresAt: this.expiryFrom(now),
      lastActivityAt: now,
      label: label ?? null,
      transcriptPersisted: false,
    };
    const result = await this.options.queryable.query(
      `INSERT INTO speakflow_sessions (id, created_at, expires_at, last_activity_at, label, transcript_persisted)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING ${COLUMNS}`,
      [record.id, record.createdAt, record.expiresAt, record.lastActivityAt, record.label],
    );
    const row = result.rows[0];
    return row === undefined ? record : toRecord(row);
  }

  async get(id: string): Promise<SessionRecord | null> {
    if (!isSessionId(id)) return null;
    await this.ensure();
    const result = await this.options.queryable.query(
      `SELECT ${COLUMNS} FROM speakflow_sessions WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const record = toRecord(row);
    if (record.expiresAt <= this.now()) {
      // Same behaviour as the memory store: a hit on an expired row removes it.
      await this.delete(id);
      return null;
    }
    return record;
  }

  async touch(id: string): Promise<void> {
    if (!isSessionId(id)) return;
    await this.ensure();
    const now = this.now();
    await this.options.queryable.query(
      `UPDATE speakflow_sessions
          SET last_activity_at = $2, expires_at = $3
        WHERE id = $1`,
      [id, now, this.expiryFrom(now)],
    );
  }

  async refresh(id: string): Promise<SessionRecord | null> {
    if (!isSessionId(id)) return null;
    await this.touch(id);
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    if (!isSessionId(id)) return false;
    await this.ensure();
    const result = await this.options.queryable.query('DELETE FROM speakflow_sessions WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async sweep(): Promise<number> {
    await this.ensure();
    const result = await this.options.queryable.query('DELETE FROM speakflow_sessions WHERE expires_at <= $1', [
      this.now(),
    ]);
    return result.rowCount ?? 0;
  }

  async count(): Promise<number> {
    await this.ensure();
    const result = await this.options.queryable.query(
      'SELECT COUNT(*)::int AS live FROM speakflow_sessions WHERE expires_at > $1',
      [this.now()],
    );
    const row = result.rows[0];
    return row === undefined ? 0 : toNumber(row.live);
  }

  async close(): Promise<void> {
    await this.options.queryable.end?.();
  }
}

/** Thin adapter so `pg`'s overloads never leak into the store's types. */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export function createPgPool(options: {
  connectionString: string;
  max: number;
  ssl: boolean;
  /** Injected by tests; production resolves the real driver. */
  poolFactory?: (config: Record<string, unknown>) => Queryable;
}): Queryable {
  const config = {
    connectionString: options.connectionString,
    max: options.max,
    // Hosted providers terminate TLS with a managed certificate chain that Node
    // does not always trust from a bare connection string; `require` here means
    // "encrypt", which is the property that matters for this metadata.
    ssl: options.ssl ? { rejectUnauthorized: false } : false,
    // A serverless instance must not sit on a dead socket for 30 s.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
  };
  if (options.poolFactory !== undefined) return options.poolFactory(config);

  /**
   * The driver is imported dynamically, for two reasons: a deployment that has
   * no DATABASE_URL never loads it at all, and the module graph stays loadable
   * under ESM bundling where a bare `require` does not exist.
   */
  let poolPromise: Promise<PgPoolLike> | null = null;
  const pool = (): Promise<PgPoolLike> => {
    if (poolPromise === null) {
      poolPromise = import('pg').then((mod) => {
        const ctor = (mod as { Pool?: unknown; default?: { Pool?: unknown } }).Pool ??
          (mod as { default?: { Pool?: unknown } }).default?.Pool;
        if (typeof ctor !== 'function') {
          throw new Error('The pg module did not expose a Pool constructor.');
        }
        return new (ctor as new (config: Record<string, unknown>) => PgPoolLike)(config);
      });
      // A failed load must not be cached forever.
      poolPromise = poolPromise.catch((error: unknown) => {
        poolPromise = null;
        throw error;
      });
    }
    return poolPromise;
  };

  return {
    async query(text, values) {
      const active = await pool();
      const result = await active.query(text, values);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    },
    async end() {
      if (poolPromise === null) return;
      const active = await poolPromise;
      await active.end();
    },
  };
}
