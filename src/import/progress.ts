import { logger } from '../logger.js';

export interface ProgressBarOptions {
  /** Short label shown on the bar, e.g. "ol-works" or "download". */
  label: string;
  /** Format a raw count for display. Defaults to toLocaleString (records). */
  format?: (n: number) => string;
  /** TTY redraw throttle in ms. Default 250. */
  ttyIntervalMs?: number;
  /** Pipe-mode granularity: log once per percent tick. Default 1. */
  pipePctTick?: number;
}

const defaultFormat = (n: number): string => n.toLocaleString();

const BAR_WIDTH = 20;

function fmtEta(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

/**
 * Terminal-centric progress renderer. On a TTY it redraws a single \r line with
 * an animated bar, percent, count, rate and ETA (throttled to ~4/s); on a pipe
 * it falls back to one pino log line per percent tick so redirected output
 * still shows progress. Shared by the dump download (bytes) and the import
 * phase (records).
 */
export class ProgressBar {
  private readonly format: (n: number) => string;
  private readonly ttyIntervalMs: number;
  private readonly pipePctTick: number;
  private readonly isTTY = Boolean(process.stdout.isTTY);
  private lastRender = 0;
  private lastPct = -1;
  private readonly startedAt = Date.now();

  constructor(private readonly opts: ProgressBarOptions) {
    this.format = opts.format ?? defaultFormat;
    this.ttyIntervalMs = opts.ttyIntervalMs ?? 250;
    this.pipePctTick = opts.pipePctTick ?? 1;
  }

  update(received: number, total: number | null): void {
    const now = Date.now();
    const elapsedSec = (now - this.startedAt) / 1000;
    const rate = elapsedSec > 0 ? received / elapsedSec : 0;
    const pct = total !== null && total > 0 ? (received / total) * 100 : null;
    const etaSec = total !== null && rate > 0 ? (total - received) / rate : null;

    if (this.isTTY) {
      if (now - this.lastRender < this.ttyIntervalMs) return;
      this.lastRender = now;

      let bar = '';
      if (pct !== null) {
        const filled = Math.round((Math.min(pct, 100) / 100) * BAR_WIDTH);
        bar = ` [${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}] ${pct.toFixed(1)}%`;
      }
      const count = `${this.format(received)}${total !== null ? ` / ${this.format(total)}` : ''}`;
      const rateStr = rate > 0 ? ` ${this.format(Math.round(rate))}/s` : '';
      const etaStr = etaSec !== null && etaSec > 0 ? ` eta ${fmtEta(etaSec)}` : '';
      process.stdout.write(`\r${this.opts.label}: ${count}${bar}${rateStr}${etaStr}   `);
      return;
    }

    const tickNow = total !== null ? Math.floor((pct ?? 0) / this.pipePctTick) : -1;
    if (tickNow !== this.lastPct) {
      this.lastPct = tickNow;
      logger.info(
        {
          label: this.opts.label,
          processed: received,
          total: total ?? null,
          pct: total !== null ? Math.floor(pct ?? 0) : null,
          ratePerSec: Math.round(rate),
          etaSec: etaSec !== null && etaSec > 0 ? Math.round(etaSec) : null,
        },
        'progress',
      );
    }
  }

  /** Clear the \r line so the next log line doesn't collide with it. */
  done(): void {
    if (this.isTTY) process.stdout.write('\n');
  }
}
