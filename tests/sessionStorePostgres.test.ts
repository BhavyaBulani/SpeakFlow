import { describe, expect, it } from 'vitest';
import {
  PostgresSessionStore,
  createPgPool,
  isSessionId,
  type Queryable,
} from '../src/server/services/sessionStorePostgres';

/**
 * The Postgres store is tested against a fake queryable rather than a live
 * database, so the mapping and the SQL contract are covered in CI. What this
 * cannot prove is that the SQL runs on real Postgres; the shape of each
 * statement is asserted instead, and `docs/DEPLOYMENT.md` records that a live
 * connection was exercised by hand.
 */

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function fakeDb(
  responder: (query: RecordedQuery) => { rows: Record<string, unknown>[]; rowCount: number | null } = () => ({
    rows: [],
    rowCount: 0,
  }),
): { queryable: Queryable; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    queryable: {
      async query(text, values = []) {
        const recorded = { text, values };
        queries.push(recorded);
        return responder(recorded);
      },
      async end() {},
    },
  };
}

const TTL_MINUTES = 120;
const NOW = 1_700_000_000_000;

function store(queryable: Queryable, overrides: { ensureSchema?: boolean } = {}): PostgresSessionStore {
  return new PostgresSessionStore({
    ttlMinutes: TTL_MINUTES,
    queryable,
    now: () => NOW,
    ...overrides,
  });
}

describe('isSessionId', () => {
  it('accepts a canonical uuid and rejects anything else', () => {
    expect(isSessionId('46786bde-d564-4b77-9414-f0f1b7d98fbb')).toBe(true);
    expect(isSessionId('not-a-uuid')).toBe(false);
    expect(isSessionId("1' OR '1'='1")).toBe(false);
    expect(isSessionId('46786bde-d564-4b77-9414')).toBe(false);
  });
});

describe('PostgresSessionStore', () => {
  it('creates the schema lazily and only once for many operations', async () => {
    const { queryable, queries } = fakeDb(({ text }) => {
      if (text.includes('SELECT COUNT')) return { rows: [{ live: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const subject = store(queryable);

    await subject.count();
    await subject.count();
    await subject.sweep();

    const creates = queries.filter((q) => q.text.includes('CREATE TABLE'));
    expect(creates).toHaveLength(1);
    expect(creates[0]?.text).toContain('speakflow_sessions');
    // The index matters: sweep() runs on every call and without it that is a
    // sequential scan of the whole table.
    expect(queries.some((q) => q.text.includes('CREATE INDEX'))).toBe(true);
  });

  it('retries a failed schema bootstrap instead of caching the failure', async () => {
    let attempt = 0;
    const { queryable } = fakeDb(({ text }) => {
      if (text.includes('CREATE TABLE')) {
        attempt += 1;
        if (attempt === 1) throw new Error('database is starting up');
      }
      return { rows: [{ live: 0 }], rowCount: 1 };
    });
    const subject = store(queryable);

    await expect(subject.count()).rejects.toThrow('database is starting up');
    // The operator fixes the database; the next request must succeed without a
    // redeploy, which is why the rejected promise is not memoised.
    await expect(subject.count()).resolves.toBe(0);
  });

  it('skips schema creation when told to', async () => {
    const { queryable, queries } = fakeDb(() => ({ rows: [{ live: 2 }], rowCount: 1 }));
    await store(queryable, { ensureSchema: false }).count();
    expect(queries.some((q) => q.text.includes('CREATE TABLE'))).toBe(false);
  });

  it('inserts a session with the configured ttl and never persists transcripts', async () => {
    // Echo the inserted row back, which is what RETURNING does, so the test
    // exercises the real round trip instead of inventing an id.
    const { queryable, queries } = fakeDb(({ text, values }) => {
      if (text.includes('INSERT')) {
        return {
          rows: [
            {
              id: values[0],
              created_at: String(values[1]),
              expires_at: String(values[2]),
              last_activity_at: String(values[3]),
              label: values[4],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const record = await store(queryable).create('Discovery call');

    expect(record.label).toBe('Discovery call');
    expect(record.transcriptPersisted).toBe(false);
    // pg returns bigint as a string; the store must coerce it, or every date in
    // the API response becomes "Invalid Date".
    expect(record.createdAt).toBe(NOW);
    expect(record.expiresAt).toBe(NOW + TTL_MINUTES * 60_000);

    const insert = queries.find((q) => q.text.includes('INSERT'));
    expect(isSessionId(record.id)).toBe(true);
    expect(insert?.values).toEqual([record.id, NOW, NOW + TTL_MINUTES * 60_000, NOW, 'Discovery call']);
    // The column exists and is written as false; there is no transcript column
    // at all, which is the point.
    expect(insert?.text).toContain('transcript_persisted');
    expect(insert?.text.toLowerCase()).not.toContain('transcript text');
  });

  it('rejects a malformed id before it reaches Postgres', async () => {
    const { queryable, queries } = fakeDb();
    const subject = store(queryable);

    // Postgres answers 22P02 for a non-uuid compared against a uuid column,
    // which would turn a client typo into a 500.
    await expect(subject.get('nope')).resolves.toBeNull();
    await expect(subject.refresh('nope')).resolves.toBeNull();
    await expect(subject.delete('nope')).resolves.toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('treats an expired row as absent and removes it', async () => {
    const id = '46786bde-d564-4b77-9414-f0f1b7d98fbb';
    const { queryable, queries } = fakeDb(({ text }) => {
      if (text.startsWith('SELECT')) {
        return {
          rows: [
            {
              id,
              created_at: String(NOW - 10_000),
              expires_at: String(NOW - 1),
              last_activity_at: String(NOW - 10_000),
              label: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(store(queryable).get(id)).resolves.toBeNull();
    expect(queries.some((q) => q.text.startsWith('DELETE'))).toBe(true);
  });

  it('returns a live row unchanged', async () => {
    const id = '46786bde-d564-4b77-9414-f0f1b7d98fbb';
    const { queryable } = fakeDb(() => ({
      rows: [
        { id, created_at: String(NOW), expires_at: String(NOW + 1000), last_activity_at: String(NOW), label: null },
      ],
      rowCount: 1,
    }));

    const record = await store(queryable).get(id);
    expect(record?.id).toBe(id);
    expect(record?.transcriptPersisted).toBe(false);
  });

  it('extends the expiry on touch, which is what keeps a long call alive', async () => {
    const id = '46786bde-d564-4b77-9414-f0f1b7d98fbb';
    const { queryable, queries } = fakeDb(() => ({ rows: [], rowCount: 1 }));

    await store(queryable).touch(id);

    const update = queries.find((q) => q.text.includes('UPDATE'));
    expect(update?.values).toEqual([id, NOW, NOW + TTL_MINUTES * 60_000]);
  });

  it('reports sweep and delete counts from rowCount', async () => {
    const { queryable } = fakeDb(() => ({ rows: [], rowCount: 4 }));
    const subject = store(queryable);
    await expect(subject.sweep()).resolves.toBe(4);
    await expect(subject.delete('46786bde-d564-4b77-9414-f0f1b7d98fbb')).resolves.toBe(true);
  });

  it('coerces the COUNT result that pg returns as a string', async () => {
    const { queryable } = fakeDb(() => ({ rows: [{ live: '7' }], rowCount: 1 }));
    await expect(store(queryable).count()).resolves.toBe(7);
  });

  it('reads count from an empty result defensively', async () => {
    const { queryable } = fakeDb(() => ({ rows: [], rowCount: 0 }));
    await expect(store(queryable).count()).resolves.toBe(0);
  });

  it('identifies itself so /api/health can say which store is live', () => {
    const { queryable } = fakeDb();
    expect(store(queryable).kind).toBe('postgres');
  });
});

describe('createPgPool', () => {
  it('passes the ssl decision and a bounded pool size to the driver', () => {
    let seen: Record<string, unknown> | null = null;
    createPgPool({
      connectionString: 'postgresql://user:pw@db.example.com:5432/app',
      max: 3,
      ssl: true,
      poolFactory: (config) => {
        seen = config;
        return { async query() { return { rows: [], rowCount: 0 }; }, async end() {} };
      },
    });

    expect(seen).not.toBeNull();
    expect(seen!.max).toBe(3);
    expect(seen!.ssl).toEqual({ rejectUnauthorized: false });
    // A serverless instance must not hold a dead socket for 30 s before giving
    // up, or the whole request runs out of its duration budget first.
    expect(seen!.connectionTimeoutMillis).toBe(10_000);
  });

  it('does not request TLS when the connection is plain', () => {
    let seen: Record<string, unknown> | null = null;
    createPgPool({
      connectionString: 'postgresql://localhost:5432/app',
      max: 2,
      ssl: false,
      poolFactory: (config) => {
        seen = config;
        return { async query() { return { rows: [], rowCount: 0 }; }, async end() {} };
      },
    });
    expect(seen!.ssl).toBe(false);
  });
});
