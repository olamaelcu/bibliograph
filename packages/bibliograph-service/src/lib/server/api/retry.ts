import type { Logger } from 'pino';

export interface RetryOpts {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryOn?: (status: number) => boolean;
}

const DEFAULT_RETRY_ON = (status: number) => status === 429 || (status >= 500 && status < 600);

export async function withRetry<T>(
  fn: () => Promise<T>,
  log: Logger,
  opts: RetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_ON;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      if (!status || !retryOn(status) || attempt === maxAttempts) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const sleep = opts.jitter !== false ? delay * (0.5 + Math.random() * 0.5) : delay;
      log.warn({ stage: 'retry', attempt, status, sleepMs: Math.round(sleep) }, 'retrying after backoff');
      await new Promise((r) => setTimeout(r, sleep));
    }
  }
  throw lastErr;
}