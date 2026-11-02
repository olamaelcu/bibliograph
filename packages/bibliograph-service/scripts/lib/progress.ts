/**
 * Single-line progress bar for the backfill CLIs.
 *
 * Paints to stderr so stdout stays a clean, parseable channel (the scripts
 * print a JSON summary line there). Without a TTY it degrades to one line at
 * the start, every 100 steps, and on completion, instead of repainting — the
 * same output a cron log wants. Repaints are rate-limited so a tight enqueue
 * loop does not spend its time formatting.
 */
export class ProgressBar {
  private count = 0;
  private lastPaintAt = 0;
  private readonly startedAt = Date.now();
  private readonly isTty = process.stderr.isTTY === true;
  private readonly label: string;
  private readonly total: number;

  constructor(label: string, total: number) {
    this.label = label;
    this.total = total;
  }

  /** Steps recorded so far. */
  get done(): number {
    return this.count;
  }

  advance(step = 1): void {
    this.count += step;
    if (!this.isTty) {
      if (this.count === 1 || this.count % 100 === 0 || this.count === this.total) {
        console.log(`${this.label} ${this.count}/${this.total}`);
      }
      return;
    }
    const now = Date.now();
    // Throttle unconditionally: a tight loop can advance thousands of times a
    // second. `finish()` guarantees the final frame.
    if (now - this.lastPaintAt < 80) return;
    this.lastPaintAt = now;
    process.stderr.write(`\r${this.line(false)}`);
  }

  /** Final frame plus newline; safe to call when nothing advanced. */
  finish(): void {
    if (!this.isTty) return;
    process.stderr.write(`\r\x1b[K${this.line(true)}\n`);
  }

  private line(finished: boolean): string {
    const width = 24;
    const ratio = this.total === 0 ? 1 : Math.min(1, this.count / this.total);
    const filled = Math.round(ratio * width);
    const head = `${this.label} ▕${'█'.repeat(filled)}${'░'.repeat(width - filled)}▏ `
      + `${this.count}/${this.total} ${String(Math.round(ratio * 100)).padStart(3)}%`;
    if (finished || this.count === 0 || this.count >= this.total) return head;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = elapsed > 0 ? this.count / elapsed : 0;
    return `${head} · ${rate.toFixed(1)}/s · eta ${Math.ceil((this.total - this.count) / rate)}s`;
  }
}
