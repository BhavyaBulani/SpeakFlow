import { logger } from '../lib/logger';
import {
  budgetDayIndex,
  describeBudget,
  unknownBudgetState,
  type AiBudget,
  type BudgetConsumption,
  type BudgetPolicy,
  type BudgetState,
} from './budget';
// The pool is created once in `services/index.ts` and shared with the session
// store, so this module only borrows its narrow interface: a serverless host
// caps connections per instance, and two pools would double that for no reason.
import type { Queryable } from './sessionStorePostgres';

/**
 * Database-backed daily budget.
 *
 * Required on any host where more than one process serves requests. An
 * in-process counter is not a *day* there: two warm instances each allow the
 * full cap, and every cold start starts again at zero. See
 * `docs/DEPLOYMENT.md`, "What is still per-instance on Vercel".
 *
 * The counter increments in a **single statement**. A read-then-write would let
 * two concurrent instances both read `used = limit - 1` and both spend, which is
 * exactly the overspend this store exists to prevent.
 */

export interface PostgresBudgetOptions extends BudgetPolicy {
  queryable: Queryable;
  /** Runs `CREATE TABLE IF NOT EXISTS` once, before the first query. */
  ensureSchema?: boolean;
  /** Log at most one failure per this interval, so an outage cannot spam logs. */
  failureLogIntervalMs?: number;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS speakflow_ai_usage (
     day_index bigint PRIMARY KEY,
     used integer NOT NULL,
     updated_at bigint NOT NULL
   )`,
];

/**
 * Reserve a call, or find out the cap is reached.
 *
 * `WHERE` on the `DO UPDATE` is what makes the cap atomic: when it is false the
 * statement touches nothing and `RETURNING` yields no row, which is the denial
 * signal. `$3 <= 0` is the "no cap configured" case, kept in the same statement
 * so both paths share one round trip.
 */
const CONSUME_STATEMENT = `INSERT INTO speakflow_ai_usage (day_index, used, updated_at)
       VALUES ($1, 1, $2)
     ON CONFLICT (day_index) DO UPDATE
        SET used = speakflow_ai_usage.used + 1,
            updated_at = EXCLUDED.updated_at
      WHERE $3::int <= 0 OR speakflow_ai_usage.used < $3::int
     RETURNING used`;

function toNumber(value: unknown): number {
  // `pg` returns bigint columns as strings to avoid precision loss.
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'bigint') return Number(value);
  return Number.NaN;
}

export class PostgresAiBudget implements AiBudget {
  readonly kind = 'postgres' as const;

  private schemaReady: Promise<void> | null = null;
  private lastFailureLogAt = 0;

  constructor(private readonly options: PostgresBudgetOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Lazy and memoised, like the session store: importing this module never does
   * I/O, and a failed bootstrap is retried rather than cached, so fixing
   * DATABASE_URL takes effect without a redeploy.
   */
  private async ensure(): Promise<void> {
    if (this.options.ensureSchema === false) return;
    if (this.schemaReady === null) {
      this.schemaReady = (async () => {
        for (const statement of SCHEMA_STATEMENTS) {
          await this.options.queryable.query(statement);
        }
        logger.info('budget_store.schema_ready');
      })();
      this.schemaReady = this.schemaReady.catch((error: unknown) => {
        this.schemaReady = null;
        throw error;
      });
    }
    await this.schemaReady;
  }

  async tryConsume(): Promise<BudgetConsumption> {
    const now = this.now();
    const dayIndex = budgetDayIndex(now);
    const limit = this.options.limit;

    try {
      await this.ensure();
      const result = await this.options.queryable.query(CONSUME_STATEMENT, [dayIndex, now, limit]);
      const row = result.rows[0];

      if (row === undefined) {
        // The cap suppressed the write. Read the real count so the caller can
        // report how far past the limit the workspace is.
        const used = await this.readUsed(dayIndex);
        return {
          allowed: false,
          state: describeBudget({ used, limit, store: this.kind, now }),
        };
      }

      return {
        allowed: true,
        state: describeBudget({ used: toNumber(row.used), limit, store: this.kind, now }),
      };
    } catch (error) {
      return { allowed: true, state: this.reportFailure(error, now) };
    }
  }

  async state(): Promise<BudgetState> {
    const now = this.now();
    try {
      await this.ensure();
      const used = await this.readUsed(budgetDayIndex(now));
      return describeBudget({ used, limit: this.options.limit, store: this.kind, now });
    } catch (error) {
      return this.reportFailure(error, now);
    }
  }

  async reset(): Promise<void> {
    await this.ensure();
    await this.options.queryable.query('DELETE FROM speakflow_ai_usage WHERE day_index = $1', [
      budgetDayIndex(this.now()),
    ]);
  }

  private async readUsed(dayIndex: number): Promise<number> {
    const result = await this.options.queryable.query(
      'SELECT used FROM speakflow_ai_usage WHERE day_index = $1',
      [dayIndex],
    );
    const row = result.rows[0];
    return row === undefined ? 0 : toNumber(row.used);
  }

  /**
   * An unreadable counter must not take the call down with it.
   *
   * Failing closed would mean one database hiccup silently stops every reply,
   * which on a live call is worse than briefly over-spending a free allowance -
   * and on this app a database hiccup usually fails the session lookup first
   * anyway. So: allow the request, and say so through `degraded` in
   * `/api/health` instead of quietly reporting `used: 0`, which would look
   * exactly like a fresh, unused budget.
   */
  private reportFailure(error: unknown, now: number): BudgetState {
    const interval = this.options.failureLogIntervalMs ?? 60_000;
    if (now - this.lastFailureLogAt >= interval) {
      this.lastFailureLogAt = now;
      logger.warn('budget_store.unavailable', {
        message: error instanceof Error ? error.message : String(error),
        hint: 'The daily AI cap could not be read, so it was not enforced for this request. /api/health reports budget.degraded: true.',
      });
    }
    return unknownBudgetState(this.options.limit, now, this.kind);
  }
}
