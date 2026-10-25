/**
 * Daily AI request budget.
 *
 * The product target is ₹0 required spend, but free tiers are finite and the
 * provisional-reply loop fires repeatedly while someone is talking. This is the
 * hard stop: once the day's allowance is used, no further provider call is made
 * and callers fall back to rules/templates that cost nothing.
 *
 * Deliberately simple and in-memory:
 *  - a UTC-day counter, so it resets without a scheduler;
 *  - per-process, so it resets on redeploy and is not shared between instances
 *    (documented, not hidden - see README "Costs and usage limits");
 *  - `limit <= 0` means "no cap configured", reported as `null`, never as 0.
 *
 * There is no paid fallback: exhausting the budget disables new AI calls, it
 * never switches to a provider that charges money.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BudgetState {
  /** Calls made today. */
  used: number;
  /** Configured cap, or null when unlimited. */
  limit: number | null;
  /** Calls left today, or null when unlimited. */
  remaining: number | null;
  exhausted: boolean;
  /** epoch ms of the next UTC midnight, when `used` returns to 0. */
  resetsAt: number;
}

export class AiRequestBudget {
  private used = 0;
  private dayIndex: number | null = null;

  constructor(
    private readonly options: {
      limit: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private dayOf(timestamp: number): number {
    return Math.floor(timestamp / DAY_MS);
  }

  /** Roll the counter over when the UTC day changes. Safe to call repeatedly. */
  private roll(): void {
    const today = this.dayOf(this.now());
    if (this.dayIndex !== today) {
      this.dayIndex = today;
      this.used = 0;
    }
  }

  /**
   * Reserve one request. Returns `allowed: false` without consuming anything
   * when the cap is already reached, so a blocked caller costs nothing.
   */
  tryConsume(): { allowed: boolean; state: BudgetState } {
    this.roll();
    const limit = this.options.limit;
    if (limit > 0 && this.used >= limit) {
      return { allowed: false, state: this.state() };
    }
    this.used += 1;
    return { allowed: true, state: this.state() };
  }

  state(): BudgetState {
    this.roll();
    const limit = this.options.limit;
    const unlimited = limit <= 0;
    return {
      used: this.used,
      limit: unlimited ? null : limit,
      remaining: unlimited ? null : Math.max(0, limit - this.used),
      exhausted: !unlimited && this.used >= limit,
      resetsAt: (this.dayOf(this.now()) + 1) * DAY_MS,
    };
  }

  reset(): void {
    this.used = 0;
    this.dayIndex = null;
  }
}
