/**
 * Daily AI request budget.
 *
 * The product target is ₹0 required spend, but free tiers are finite and the
 * provisional-reply loop fires repeatedly while someone is talking. This is the
 * hard stop: once the day's allowance is used, no further provider call is made
 * and callers fall back to rules/templates that cost nothing.
 *
 * Two implementations behind one interface, chosen exactly like the session
 * store (`./budgetStorePostgres.ts`):
 *
 *  - `MemoryAiRequestBudget` keeps a UTC-day counter in the process. Correct for
 *    `npm run dev`, tests and a single long-lived instance.
 *  - `PostgresAiBudget` keeps it in the database, because a serverless host runs
 *    many instances and a per-process counter is not a day: two warm instances
 *    spend twice the allowance and every cold start resets it.
 *
 * Semantics that both must honour:
 *  - a UTC-day counter, so it resets without a scheduler;
 *  - `limit <= 0` means "no cap configured", reported as `null`, never as 0;
 *  - a denied request consumes nothing;
 *  - there is no paid fallback - exhausting the budget disables new AI calls,
 *    it never switches to a provider that charges money.
 *
 * The counter is a spending guard, not an accounting ledger: the reservation is
 * taken *before* the provider call, so a cancelled or failed request still
 * counts. That is deliberate - it is the only ordering that cannot overspend.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day number. Exported so both stores agree on where "today" starts. */
export function budgetDayIndex(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS);
}

export type BudgetStoreKind = 'memory' | 'postgres';

export interface BudgetState {
  /** Calls made today, or null when the shared counter could not be read. */
  used: number | null;
  /** Configured cap, or null when unlimited. */
  limit: number | null;
  /** Calls left today, or null when unlimited (or unknown). */
  remaining: number | null;
  exhausted: boolean;
  /** epoch ms of the next UTC midnight, when `used` returns to 0. */
  resetsAt: number;
  /** Where the counter lives. `postgres` means every instance shares it. */
  store: BudgetStoreKind;
  /**
   * True when the shared counter could not be read. The cap was **not**
   * enforced for that request, and `/api/health` says so rather than reporting
   * a comfortable `used: 0`.
   */
  degraded: boolean;
}

export interface BudgetConsumption {
  allowed: boolean;
  state: BudgetState;
}

/** What a route or engine needs from the budget. */
export interface AiBudget {
  readonly kind: BudgetStoreKind;
  /** Reserve one provider call. Denying must not consume anything. */
  tryConsume(): Promise<BudgetConsumption>;
  state(): Promise<BudgetState>;
  /** Forget today's usage. Test/operator hook; not reachable over HTTP. */
  reset(): Promise<void>;
}

export interface BudgetPolicy {
  /** Cap for the UTC day. `<= 0` means unlimited. */
  limit: number;
  now?: () => number;
}

/** Build the reported state from a known `used` count. */
export function describeBudget(options: {
  used: number | null;
  limit: number;
  store: BudgetStoreKind;
  now: number;
  degraded?: boolean;
}): BudgetState {
  const { used, limit, now } = options;
  const unlimited = limit <= 0;
  const degraded = options.degraded === true;
  return {
    used,
    limit: unlimited ? null : limit,
    remaining:
      unlimited || used === null ? null : Math.max(0, limit - used),
    exhausted: !unlimited && used !== null && used >= limit,
    resetsAt: (budgetDayIndex(now) + 1) * DAY_MS,
    store: options.store,
    degraded,
  };
}

/** The state reported when the counter could not be read at all. */
export function unknownBudgetState(
  limit: number,
  now: number,
  store: BudgetStoreKind,
): BudgetState {
  return describeBudget({ used: null, limit, store, now, degraded: true });
}

/**
 * In-process counter. One instance per server process, which is why it is only
 * correct for a single long-lived process.
 */
export class MemoryAiRequestBudget implements AiBudget {
  readonly kind = 'memory' as const;

  private used = 0;
  private dayIndex: number | null = null;

  constructor(private readonly options: BudgetPolicy) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Roll the counter over when the UTC day changes. Safe to call repeatedly. */
  private roll(): void {
    const today = budgetDayIndex(this.now());
    if (this.dayIndex !== today) {
      this.dayIndex = today;
      this.used = 0;
    }
  }

  async tryConsume(): Promise<BudgetConsumption> {
    this.roll();
    const limit = this.options.limit;
    if (limit > 0 && this.used >= limit) {
      return { allowed: false, state: this.snapshot() };
    }
    this.used += 1;
    return { allowed: true, state: this.snapshot() };
  }

  async state(): Promise<BudgetState> {
    return this.snapshot();
  }

  async reset(): Promise<void> {
    this.used = 0;
    this.dayIndex = null;
  }

  private snapshot(): BudgetState {
    this.roll();
    return describeBudget({
      used: this.used,
      limit: this.options.limit,
      store: this.kind,
      now: this.now(),
    });
  }
}
