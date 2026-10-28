import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { generateReply } from '../src/server/services/replyEngine';
import { createApp } from '../src/server/app';
import { deriveConfig } from '../src/server/config';
import { CircuitBreaker } from '../src/server/services/breaker';
import {
  MemoryAiRequestBudget,
  budgetDayIndex,
  describeBudget,
  type AiBudget,
} from '../src/server/services/budget';
import { PostgresAiBudget } from '../src/server/services/budgetStorePostgres';
import type { Queryable } from '../src/server/services/sessionStorePostgres';
import { MockAiClient } from '../src/server/services/openai';

/**
 * The daily AI cap is the only thing standing between a free tier and a bill,
 * so it is tested where it is enforced rather than only where it is reported.
 *
 * Note what these tests are *not*: the Postgres cases run against a fake
 * queryable, so they pin the SQL contract and the mapping, not real Postgres.
 * `docs/DEPLOYMENT.md` says the same about the session store.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function memory(limit: number, now: () => number = () => NOW): MemoryAiRequestBudget {
  return new MemoryAiRequestBudget({ limit, now });
}

describe('MemoryAiRequestBudget', () => {
  it('allows exactly the configured number of calls, then denies', async () => {
    const budget = memory(2);
    expect((await budget.tryConsume()).allowed).toBe(true);
    expect((await budget.tryConsume()).allowed).toBe(true);

    const denied = await budget.tryConsume();
    expect(denied.allowed).toBe(false);
    expect(denied.state.exhausted).toBe(true);
    expect(denied.state.remaining).toBe(0);
  });

  it('does not consume anything when it denies', async () => {
    const budget = memory(1);
    await budget.tryConsume();
    await budget.tryConsume();
    await budget.tryConsume();
    // A denial that counted itself would let `used` drift past the cap and make
    // the reported number meaningless.
    expect((await budget.state()).used).toBe(1);
  });

  it('treats a non-positive limit as unlimited and reports null, not 0', async () => {
    const budget = memory(0);
    for (let i = 0; i < 5; i += 1) {
      expect((await budget.tryConsume()).allowed).toBe(true);
    }
    const state = await budget.state();
    expect(state.limit).toBeNull();
    expect(state.remaining).toBeNull();
    expect(state.exhausted).toBe(false);
  });

  it('rolls the counter over at UTC midnight without a scheduler', async () => {
    let clock = NOW;
    const budget = memory(1, () => clock);
    expect((await budget.tryConsume()).allowed).toBe(true);
    expect((await budget.tryConsume()).allowed).toBe(false);

    clock += DAY_MS;
    const afterMidnight = await budget.tryConsume();
    expect(afterMidnight.allowed).toBe(true);
    expect(afterMidnight.state.used).toBe(1);
  });

  it('reports where the counter lives, so a per-instance cap is visible', async () => {
    expect((await memory(5).state()).store).toBe('memory');
  });
});

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function fakeDb(
  responder: (query: RecordedQuery) => { rows: Record<string, unknown>[]; rowCount: number | null },
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

describe('PostgresAiBudget', () => {
  it('increments and checks the cap in one statement, not read-then-write', async () => {
    const { queryable, queries } = fakeDb(({ text }) => {
      if (text.includes('INSERT INTO speakflow_ai_usage')) return { rows: [{ used: '1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const budget = new PostgresAiBudget({ limit: 10, queryable, now: () => NOW });

    const result = await budget.tryConsume();

    expect(result.allowed).toBe(true);
    // bigint comes back as a string from `pg`; it must not leak to callers.
    expect(result.state.used).toBe(1);
    const writes = queries.filter((q) => q.text.includes('INSERT INTO speakflow_ai_usage'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.text).toContain('ON CONFLICT');
    // A separate SELECT before the UPDATE would allow two instances to both read
    // `limit - 1` and both spend.
    expect(queries.some((q) => q.text.includes('SELECT used FROM speakflow_ai_usage'))).toBe(false);
    expect(writes[0]?.values.slice(0, 3)).toEqual([budgetDayIndex(NOW), NOW, 10]);
  });

  it('reports denial when the atomic statement writes no row, and reads the real count', async () => {
    const { queryable } = fakeDb(({ text }) => {
      if (text.includes('INSERT INTO speakflow_ai_usage')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT used FROM speakflow_ai_usage')) return { rows: [{ used: '10' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const budget = new PostgresAiBudget({ limit: 10, queryable, now: () => NOW });

    const result = await budget.tryConsume();

    expect(result.allowed).toBe(false);
    expect(result.state.used).toBe(10);
    expect(result.state.exhausted).toBe(true);
    expect(result.state.store).toBe('postgres');
  });

  it('creates the schema once and retries a failed bootstrap', async () => {
    let failures = 0;
    const { queryable, queries } = fakeDb(({ text }) => {
      if (text.includes('CREATE TABLE') && failures === 0) {
        failures += 1;
        throw new Error('no connection');
      }
      if (text.includes('SELECT used')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const budget = new PostgresAiBudget({ limit: 5, queryable, now: () => NOW });

    // First call fails to bootstrap; it must not be cached forever.
    const first = await budget.state();
    expect(first.degraded).toBe(true);

    await budget.state();
    await budget.state();
    expect(queries.filter((q) => q.text.includes('CREATE TABLE'))).toHaveLength(2);
  });

  it('lets the request through but says so when the counter is unreadable', async () => {
    const { queryable } = fakeDb(() => {
      throw new Error('connection terminated');
    });
    const budget = new PostgresAiBudget({ limit: 5, queryable, now: () => NOW });

    const result = await budget.tryConsume();

    // Failing closed would stop every reply on a live call over a database
    // hiccup; the honest answer is to allow it and report `degraded`.
    expect(result.allowed).toBe(true);
    expect(result.state.degraded).toBe(true);
    expect(result.state.used).toBeNull();
    // Reporting used: 0 here would look exactly like a fresh, unused budget.
    expect(result.state.remaining).toBeNull();
  });

  it('resets only today, never the whole table', async () => {
    const { queryable, queries } = fakeDb(() => ({ rows: [], rowCount: 0 }));
    const budget = new PostgresAiBudget({ limit: 5, queryable, now: () => NOW });

    await budget.reset();

    const deletes = queries.filter((q) => q.text.startsWith('DELETE'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.values).toEqual([budgetDayIndex(NOW)]);
  });

  it('describeBudget keeps used=null from becoming a confident zero', () => {
    const state = describeBudget({ used: null, limit: 5, store: 'postgres', now: NOW });
    expect(state.used).toBeNull();
    expect(state.remaining).toBeNull();
    expect(state.exhausted).toBe(false);
    expect(state.resetsAt).toBe((budgetDayIndex(NOW) + 1) * DAY_MS);
  });
});

/** A budget that is always out of allowance. */
const exhausted: AiBudget = {
  kind: 'memory',
  async tryConsume() {
    return { allowed: false, state: describeBudget({ used: 200, limit: 200, store: 'memory', now: NOW }) };
  },
  async state() {
    return describeBudget({ used: 200, limit: 200, store: 'memory', now: NOW });
  },
  async reset() {},
};

const REPLY_INPUT = {
  version: 1,
  stage: 'refined' as const,
  utterance: 'Can you send the numbers over before Friday?',
  recentFinals: [] as string[],
  tone: 'professional' as const,
  userContext: '',
  utteranceUnfinished: false,
};

describe('generateReply under the daily cap', () => {
  it('never calls the provider once the cap is reached', async () => {
    const ai = new MockAiClient();
    const config = deriveConfig({ NODE_ENV: 'test', MOCK_AI: '1' });
    const services = {
      config: { ...config, aiDailyRequestBudget: 200 },
      ai,
      breaker: new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: () => NOW }),
      budget: exhausted,
    };

    const result = await generateReply(services as never, REPLY_INPUT);

    expect(result.engine).toBe('safe_fallback');
    // The whole point: no provider call was made, so nothing can be billed.
    expect(result.model).toBe('none');
    expect(result.notice).toContain('budget');
  });

  it('answers from the free fast path without spending allowance', async () => {
    const config = deriveConfig({ NODE_ENV: 'test', MOCK_AI: '1' });
    const budget = memory(1);
    const services = {
      config: { ...config, fastPathEnabled: true },
      ai: new MockAiClient(),
      breaker: new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: () => NOW }),
      budget,
    };

    const result = await generateReply(services as never, { ...REPLY_INPUT, stage: 'provisional' });

    // Invariant either way: a template answer costs the allowance nothing, and
    // a provider answer costs exactly one.
    const spent = (await budget.state()).used;
    expect(spent).toBe(result.engine === 'local_library' ? 0 : 1);
  });
});

describe('the cap over HTTP', () => {
  function appWithBudget(budget: AiBudget) {
    const config = deriveConfig({
      NODE_ENV: 'test',
      MOCK_AI: '1',
      RATE_LIMIT_MAX: '1000',
      AI_RATE_LIMIT_MAX: '1000',
      ENABLE_VOCAB_PERSISTENCE: '0',
    } as NodeJS.ProcessEnv);
    return createApp({ config, overrides: { budget } });
  }

  it('answers 429 AI_BUDGET_EXHAUSTED for translation, which has no holding line', async () => {
    const { app } = appWithBudget(exhausted);
    const response = await request(app)
      .post('/api/translate')
      .send({ text: 'kal tak ho jayega', targetTone: 'professional' });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('AI_BUDGET_EXHAUSTED');
  });

  it('reports the cap and where it lives on /api/health', async () => {
    const { app } = appWithBudget(memory(200));
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.budget.limit).toBe(200);
    expect(response.body.budget.used).toBe(0);
    // A per-instance counter must be visible as such, not implied to be shared.
    expect(response.body.budget.store).toBe('memory');
    expect(response.body.budget.degraded).toBe(false);
  });
});
