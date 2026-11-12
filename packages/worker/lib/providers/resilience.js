/**
 * Dependency-free retry, circuit breaker, and telemetry for provider HTTP.
 *
 * Each provider identity (`googlebooks`, `isbndb`, `goodreads`) gets its own
 * breaker and counters. The layer wraps the raw `fetch` implementation, so it
 * sees every attempt while the provider's quota/cache logic still runs once per
 * logical query: retries never reserve another ISBNdb call.
 */

export const PROVIDER_IDS = ['googlebooks', 'isbndb', 'goodreads'];

/** Transient statuses worth another attempt. 400/401/403/404 are answers, not outages. */
export const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export const MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 250;
export const RETRY_MAX_DELAY_MS = 4_000;
/** A provider may ask us to wait; cap that at ten seconds so one job cannot stall. */
export const RETRY_AFTER_MAX_MS = 10_000;
/** Failed logical requests (after retries) before the breaker opens, then cooldown. */
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 30_000;

const DEFAULT_TIMEOUT_MS = 15_000;
const BREAKER_STATE_VALUES = { closed: 0, 'half-open': 1, open: 2 };

/** Thrown by an open breaker before any network call is made. */
export class ProviderCircuitOpenError extends Error {
  constructor(provider, retryAfterMs) {
    super(`${provider} circuit breaker is open`);
    this.name = 'ProviderCircuitOpenError';
    this.code = 'PROVIDER_CIRCUIT_OPEN';
    this.provider = provider;
    this.status = 503;
    this.retryAfterMs = retryAfterMs;
  }
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function providerOrder(a, b) {
  const left = PROVIDER_IDS.indexOf(a);
  const right = PROVIDER_IDS.indexOf(b);
  if (left !== -1 || right !== -1) {
    if (left === -1) return 1;
    if (right === -1) return -1;
    return left - right;
  }
  return a.localeCompare(b);
}

/**
 * In-process metrics registry. One registry per worker/provider set keeps tests
 * and multiple `createProviders` instances isolated from each other.
 */
export function createProviderMetrics() {
  const attempts = new Map();
  const retries = new Map();
  const requests = new Map();
  const breakers = new Map(PROVIDER_IDS.map((provider) => [provider, 'closed']));

  function bump(store, provider, key) {
    let counters = store.get(provider);
    if (!counters) {
      counters = new Map();
      store.set(provider, counters);
    }
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }

  return {
    recordAttempt(provider, attempt, outcome) {
      bump(attempts, provider, `${attempt}|${outcome}`);
    },
    recordRetry(provider, reason) {
      bump(retries, provider, reason);
    },
    recordRequest(provider, outcome) {
      bump(requests, provider, outcome);
    },
    setBreakerState(provider, state) {
      breakers.set(provider, state);
    },
    snapshot() {
      const attemptRows = [];
      for (const [provider, counters] of attempts) {
        for (const [key, count] of counters) {
          const [attempt, outcome] = key.split('|');
          attemptRows.push({ provider, attempt: Number(attempt), outcome, count });
        }
      }
      const retryRows = [];
      for (const [provider, counters] of retries) {
        for (const [reason, count] of counters) retryRows.push({ provider, reason, count });
      }
      const requestRows = [];
      for (const [provider, counters] of requests) {
        for (const [outcome, count] of counters) requestRows.push({ provider, outcome, count });
      }
      const breakerRows = [...breakers].map(([provider, state]) => ({ provider, state }));
      return {
        attempts: attemptRows,
        retries: retryRows,
        requests: requestRows,
        breaker: breakerRows
      };
    }
  };
}

/** Prometheus text for the provider counters; empty families still carry HELP/TYPE. */
export function renderProviderMetrics(metrics) {
  const snapshot =
    metrics?.snapshot?.() ?? {
      attempts: [],
      retries: [],
      requests: [],
      breaker: PROVIDER_IDS.map((provider) => ({ provider, state: 'closed' }))
    };

  const lines = [
    '# HELP bibliograph_provider_attempts_total Provider HTTP attempts by provider, attempt, and outcome.',
    '# TYPE bibliograph_provider_attempts_total counter'
  ];
  const attempts = [...snapshot.attempts].sort(
    (a, b) =>
      providerOrder(a.provider, b.provider) ||
      a.attempt - b.attempt ||
      a.outcome.localeCompare(b.outcome)
  );
  for (const row of attempts) {
    lines.push(
      `bibliograph_provider_attempts_total{provider="${escapeLabel(row.provider)}",` +
        `attempt="${row.attempt}",outcome="${escapeLabel(row.outcome)}"} ${row.count}`
    );
  }

  lines.push(
    '# HELP bibliograph_provider_retries_total Provider HTTP retries by provider and reason.',
    '# TYPE bibliograph_provider_retries_total counter'
  );
  const retries = [...snapshot.retries].sort(
    (a, b) => providerOrder(a.provider, b.provider) || a.reason.localeCompare(b.reason)
  );
  for (const row of retries) {
    lines.push(
      `bibliograph_provider_retries_total{provider="${escapeLabel(row.provider)}",` +
        `reason="${escapeLabel(row.reason)}"} ${row.count}`
    );
  }

  lines.push(
    '# HELP bibliograph_provider_requests_total Provider HTTP requests by provider and outcome.',
    '# TYPE bibliograph_provider_requests_total counter'
  );
  const requests = [...snapshot.requests].sort(
    (a, b) => providerOrder(a.provider, b.provider) || a.outcome.localeCompare(b.outcome)
  );
  for (const row of requests) {
    lines.push(
      `bibliograph_provider_requests_total{provider="${escapeLabel(row.provider)}",` +
        `outcome="${escapeLabel(row.outcome)}"} ${row.count}`
    );
  }

  lines.push(
    '# HELP bibliograph_provider_breaker_state Provider circuit breaker state (0 closed, 1 half-open, 2 open).',
    '# TYPE bibliograph_provider_breaker_state gauge'
  );
  const breaker = [...snapshot.breaker].sort((a, b) => providerOrder(a.provider, b.provider));
  for (const row of breaker) {
    lines.push(
      `bibliograph_provider_breaker_state{provider="${escapeLabel(row.provider)}"} ` +
        `${BREAKER_STATE_VALUES[row.state] ?? 0}`
    );
  }

  return lines.join('\n');
}

/** HTTP-date or delta-seconds Retry-After, capped; `undefined` when absent/invalid. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, RETRY_AFTER_MAX_MS);
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - nowMs), RETRY_AFTER_MAX_MS);
}

/** Exponential backoff with jitter: half the ceiling plus a random half. */
export function backoffDelay({
  attempt,
  baseDelayMs = RETRY_BASE_DELAY_MS,
  maxDelayMs = RETRY_MAX_DELAY_MS,
  random = Math.random
}) {
  const ceiling = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const half = ceiling / 2;
  return Math.max(0, Math.round(half + random() * half));
}

function isTimeoutError(error) {
  return (
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR'
  );
}

function httpError(url, status, retryAfterMs) {
  const error = new Error(`${url} answered ${status}`);
  error.status = status;
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

async function discardBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The attempt is already being replaced; a body cancellation failure is noise.
  }
}

export function createCircuitBreaker({
  provider,
  metrics,
  now = Date.now,
  failureThreshold = BREAKER_FAILURE_THRESHOLD,
  cooldownMs = BREAKER_COOLDOWN_MS
} = {}) {
  if (!provider) throw new Error('createCircuitBreaker requires a provider');
  let state = 'closed';
  let failures = 0;
  let openUntil = 0;
  let probing = false;
  metrics?.setBreakerState(provider, state);

  function transition(next) {
    if (state === next) return;
    state = next;
    metrics?.setBreakerState(provider, state);
  }

  return {
    get state() {
      return state;
    },
    get failures() {
      return failures;
    },
    /**
     * Admit one request. Returns `'normal'` in the closed state or `'probe'`
     * for the single half-open trial. Throws while open before cooldown, and
     * while another half-open probe is still in flight.
     */
    acquire() {
      const time = now();
      if (state === 'open') {
        if (time < openUntil) throw new ProviderCircuitOpenError(provider, openUntil - time);
        probing = true;
        transition('half-open');
        return 'probe';
      }
      if (state === 'half-open') {
        if (probing) throw new ProviderCircuitOpenError(provider, 0);
        probing = true;
        return 'probe';
      }
      return 'normal';
    },
    succeed(permit) {
      failures = 0;
      if (permit === 'probe') probing = false;
      transition('closed');
    },
    fail(permit) {
      if (permit === 'probe') {
        probing = false;
        openUntil = now() + cooldownMs;
        transition('open');
        return;
      }
      failures += 1;
      if (failures >= failureThreshold) {
        openUntil = now() + cooldownMs;
        transition('open');
      }
    },
    /** A hard 4xx proves the upstream is reachable; it is not an outage. */
    reachable(permit) {
      failures = 0;
      if (permit === 'probe') probing = false;
      transition('closed');
    }
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a `fetch` implementation with per-attempt timeouts, bounded retries, and
 * a breaker. The returned function has the same `(url, options)` shape, so it
 * can be passed anywhere a `fetch` is expected (including the JSON/text helpers
 * in `http.js`).
 */
export function createResilientFetch({
  provider,
  fetchImpl = fetch,
  metrics,
  breaker,
  now = Date.now,
  sleep = defaultSleep,
  random = Math.random,
  maxAttempts = MAX_ATTEMPTS,
  baseDelayMs = RETRY_BASE_DELAY_MS,
  maxDelayMs = RETRY_MAX_DELAY_MS,
  retryAfterMaxMs = RETRY_AFTER_MAX_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!provider) throw new Error('createResilientFetch requires a provider');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('createResilientFetch requires a positive integer maxAttempts');
  }
  const circuit =
    breaker ?? createCircuitBreaker({ provider, metrics, now });

  return async function resilientFetch(url, options = {}) {
    let permit;
    try {
      permit = circuit.acquire();
    } catch (error) {
      metrics?.recordRequest(provider, 'circuit_open');
      throw error;
    }

    // `http.js` supplies a whole-call signal; replace it with a fresh one per
    // attempt so a timed-out first try does not poison the retries.
    const { signal: _ignoredSignal, ...init } = options;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          ...init,
          redirect: init.redirect ?? 'follow',
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        lastError = error;
        const reason = isTimeoutError(error) ? 'timeout' : 'network';
        if (attempt < maxAttempts) {
          metrics?.recordAttempt(provider, attempt, 'retry');
          metrics?.recordRetry(provider, reason);
          await sleep(backoffDelay({ attempt, baseDelayMs, maxDelayMs, random }));
          continue;
        }
        metrics?.recordAttempt(provider, attempt, 'failure');
        metrics?.recordRequest(provider, 'error');
        circuit.fail(permit);
        throw error;
      }

      if (RETRYABLE_STATUSES.has(response.status)) {
        const reason = `status_${response.status}`;
        const parsed = parseRetryAfter(response.headers?.get?.('retry-after'), now());
        const retryAfterMs =
          parsed === undefined ? undefined : Math.min(parsed, retryAfterMaxMs);
        if (attempt < maxAttempts) {
          metrics?.recordAttempt(provider, attempt, 'retry');
          metrics?.recordRetry(provider, reason);
          await discardBody(response);
          await sleep(
            retryAfterMs === undefined
              ? backoffDelay({ attempt, baseDelayMs, maxDelayMs, random })
              : retryAfterMs
          );
          continue;
        }
        metrics?.recordAttempt(provider, attempt, 'failure');
        metrics?.recordRequest(provider, 'error');
        circuit.fail(permit);
        await discardBody(response);
        throw httpError(url, response.status, retryAfterMs);
      }

      metrics?.recordAttempt(provider, attempt, 'success');
      circuit.reachable(permit);
      metrics?.recordRequest(
        provider,
        response.ok ? 'success' : response.status === 404 ? 'not_found' : 'client_error'
      );
      return response;
    }

    circuit.fail(permit);
    throw lastError ?? new Error(`${provider} request failed`);
  };
}

/** Pair one provider identity with its breaker and resilient fetch function. */
export function createProviderHttp({
  provider,
  fetchImpl = fetch,
  metrics,
  now = Date.now,
  sleep,
  random,
  maxAttempts = MAX_ATTEMPTS,
  baseDelayMs = RETRY_BASE_DELAY_MS,
  maxDelayMs = RETRY_MAX_DELAY_MS,
  retryAfterMaxMs = RETRY_AFTER_MAX_MS,
  failureThreshold = BREAKER_FAILURE_THRESHOLD,
  cooldownMs = BREAKER_COOLDOWN_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const breaker = createCircuitBreaker({
    provider,
    metrics,
    now,
    failureThreshold,
    cooldownMs
  });
  const request = createResilientFetch({
    provider,
    fetchImpl,
    metrics,
    breaker,
    now,
    sleep,
    random,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    retryAfterMaxMs,
    timeoutMs
  });
  return { provider, breaker, fetch: request };
}
