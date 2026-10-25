/**
 * Small consecutive-failure circuit breaker.
 *
 * On a live call, repeatedly hitting a failing provider makes every transcript
 * update slower and noisier. After `threshold` consecutive failures the breaker
 * opens for `cooldownMs` and callers return their safe fallback immediately
 * instead of waiting on a doomed request.
 */
export interface BreakerState {
  open: boolean;
  consecutiveFailures: number;
  openedUntil: number | null;
}

export class CircuitBreaker {
  private failures = 0;
  private openedUntil: number | null = null;
  private halfOpenTrialInFlight = false;

  constructor(
    private readonly options: {
      threshold: number;
      cooldownMs: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** True when callers should skip the provider entirely. */
  isOpen(): boolean {
    const openedUntil = this.openedUntil;
    if (openedUntil === null) return false;
    if (this.now() >= openedUntil) {
      // Cooldown finished: allow exactly one trial request to probe recovery.
      if (this.halfOpenTrialInFlight) return true;
      this.halfOpenTrialInFlight = true;
      this.openedUntil = null;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedUntil = null;
    this.halfOpenTrialInFlight = false;
  }

  recordFailure(): void {
    this.failures += 1;
    this.halfOpenTrialInFlight = false;
    if (this.failures >= this.options.threshold) {
      this.openedUntil = this.now() + this.options.cooldownMs;
    }
  }

  state(): BreakerState {
    return {
      open: this.isOpen(),
      consecutiveFailures: this.failures,
      openedUntil: this.openedUntil,
    };
  }

  reset(): void {
    this.failures = 0;
    this.openedUntil = null;
    this.halfOpenTrialInFlight = false;
  }
}
