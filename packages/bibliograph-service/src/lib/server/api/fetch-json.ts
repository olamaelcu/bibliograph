import type { Logger } from 'pino';
import { withRetry } from './retry';
import { searchProviderRequestsTotal } from '../metrics';
import type { CircuitBreaker } from './breaker';
import { requestJson } from '../http/client';

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
 *
 * The transport (timeout, user agent, status classification) comes from
 * `../http/client`; retry and the breaker stay here because they are per
 * provider.
 */
export async function fetchJson<T>(
  url: string,
  log: Logger,
  signal: AbortSignal | undefined,
  opts: FetchJsonOptions,
): Promise<T | null> {
  const { breaker, provider, stage } = opts;
  if (!breaker.canCall()) {
    log.warn({ stage, breaker: breaker.getState() }, 'breaker open; skipping fetch');
    return null;
  }
  const start = performance.now();
  try {
    const body = await withRetry(() => requestJson<T>(url, { signal }), log);
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    log.info({ stage, url, durationMs }, `${provider} ok`);
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
