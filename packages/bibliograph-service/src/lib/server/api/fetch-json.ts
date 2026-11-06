import type { Logger } from 'pino';
import { withRetry } from './retry';
import { searchProviderRequestsTotal } from '../metrics';
import type { CircuitBreaker } from './breaker';

const UA = 'Bibliograph/0.1 (https://biblio.livtet.olamaelcu.net)';

/**
 * The upstream a request belongs to: its own breaker, metric label and log
 * stage. All three are required — a caller that forgets one would otherwise
 * bill another provider's breaker for its failures.
 */
export interface FetchJsonOptions {
  breaker: CircuitBreaker;
  provider: string;
  stage: string;
}

/**
 * GET `url` as JSON under a breaker, recording success/failure on it and
 * counting the request per provider. Returns null when the breaker is open or
 * the request failed: deciding what a null means is the caller's job.
 */
export async function fetchJson<T>(
  url: string,
  log: Logger,
  signal: AbortSignal,
  opts: FetchJsonOptions,
): Promise<T | null> {
  const { breaker, provider, stage } = opts;
  if (!breaker.canCall()) {
    log.warn({ stage, breaker: breaker.getState() }, 'breaker open; skipping fetch');
    return null;
  }
  const start = performance.now();
  try {
    const body = await withRetry(async () => {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal });
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`${provider} ${res.status}: ${text.slice(0, 200)}`) as Error & { status: number };
        (err as Error & { status: number }).status = res.status;
        throw err;
      }
      log.info({ stage, url, durationMs }, `${provider} ok`);
      return res.json() as Promise<T>;
    }, log);
    breaker.recordSuccess();
    searchProviderRequestsTotal.inc({ provider, status: 'success' });
    return body;
  } catch (err) {
    breaker.recordFailure();
    log.error({ stage, err, url }, `${provider} fetch failed`);
    searchProviderRequestsTotal.inc({ provider, status: 'failure' });
    return null;
  }
}
