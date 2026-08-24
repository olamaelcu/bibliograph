/**
 * Per-upstream in-memory circuit breaker.
 *
 * States: closed (allow all), open (reject all), half-open (allow one probe).
 * Opens after `threshold` consecutive failures; stays open for `openMs`,
 * then half-opens to allow one probe; closes on success.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private state: BreakerState = 'closed';
  private openedAt = 0;
  private nowFn: () => number;

  constructor(
    private readonly name: string,
    private readonly threshold = 5,
    private readonly openMs = 60_000,
    nowFn: () => number = Date.now,
  ) {
    this.nowFn = nowFn;
  }

  getName(): string {
    return this.name;
  }

  getState(): BreakerState {
    // Auto-transition open → half-open if openMs elapsed.
    if (this.state === 'open' && this.nowFn() - this.openedAt >= this.openMs) {
      this.state = 'half-open';
    }
    return this.state;
  }

  canCall(): boolean {
    const s = this.getState();
    return s === 'closed' || s === 'half-open';
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.nowFn();
    }
  }
}