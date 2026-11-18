import { expect, test } from 'vitest';

import { createIsbndb } from '../lib/providers/isbndb.js';
import { createProviders } from '../lib/providers/index.js';
import {
  MAX_ATTEMPTS,
  ProviderCircuitOpenError,
  createCircuitBreaker,
  createProviderHttp,
  createProviderMetrics,
  parseRetryAfter
} from '../lib/providers/resilience.js';
import { renderMetrics } from '../lib/metrics.js';

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    body: { async cancel() {} }
  };
}

function scriptedFetch(script) {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options });
      const next = script.shift();
      if (!next) throw new Error(`unexpected fetch for ${url}`);
      return typeof next === 'function' ? next(url, options) : next;
    }
  };
}

test('retries a transient 503 then succeeds', async () => {
  const metrics = createProviderMetrics();
  const { fetch, calls } = scriptedFetch([response(503), response(200, { ok: true })]);
  const http = createProviderHttp({
    provider: 'googlebooks',
    fetchImpl: fetch,
    metrics,
    sleep: async () => {},
    random: () => 0.5
  });

  const result = await http.fetch('https://provider.test/x');

  expect(result.status).toBe(200);
  expect(calls.length).toBe(2);
  expect(http.breaker.state).toBe('closed');
  const snapshot = metrics.snapshot();
  expect(snapshot.attempts.some(
      (row) =>
        row.provider === 'googlebooks' &&
        row.attempt === 1 &&
        row.outcome === 'retry' &&
        row.count === 1
    )).toBeTruthy();
  expect(snapshot.attempts.some(
      (row) =>
        row.provider === 'googlebooks' &&
        row.attempt === 2 &&
        row.outcome === 'success' &&
        row.count === 1
    )).toBeTruthy();
  expect(snapshot.retries).toEqual([
    { provider: 'googlebooks', reason: 'status_503', count: 1 }
  ]);
});

test('retries network and timeout failures', async () => {
  const timeout = Object.assign(new Error('the operation was aborted'), {
    name: 'TimeoutError'
  });
  const sleeps = [];
  const { fetch, calls } = scriptedFetch([
    async () => {
      throw timeout;
    },
    response(200, {})
  ]);
  const http = createProviderHttp({
    provider: 'goodreads',
    fetchImpl: fetch,
    sleep: async (ms) => sleeps.push(ms),
    random: () => 0.5
  });

  const result = await http.fetch('https://provider.test/x');
  expect(result.status).toBe(200);
  expect(calls.length).toBe(2);
  expect(sleeps.length).toBe(1);

  const { fetch: networkFetch } = scriptedFetch([
    async () => {
      throw new TypeError('fetch failed');
    },
    response(200, {})
  ]);
  const networkHttp = createProviderHttp({
    provider: 'goodreads',
    fetchImpl: networkFetch,
    sleep: async () => {},
    random: () => 0.5
  });
  await networkHttp.fetch('https://provider.test/x');
});

for (const status of [400, 401, 403, 404]) {
  test(`does not retry a non-retryable ${status}`, async () => {
    const metrics = createProviderMetrics();
    const sleeps = [];
    const { fetch, calls } = scriptedFetch([response(status)]);
    const http = createProviderHttp({
      provider: 'googlebooks',
      fetchImpl: fetch,
      metrics,
      sleep: async (ms) => sleeps.push(ms),
      random: () => 0.5
    });

    const result = await http.fetch('https://provider.test/x');

    expect(result.status).toBe(status);
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
    expect(http.breaker.state).toBe('closed');
    const snapshot = metrics.snapshot();
    expect(snapshot.retries.length).toBe(0);
    expect(snapshot.requests.some(
        (row) => row.provider === 'googlebooks' && row.outcome !== 'error'
      )).toBeTruthy();
  });
}

test('caps attempts and uses injected exponential backoff', async () => {
  const sleeps = [];
  const metrics = createProviderMetrics();
  const { fetch, calls } = scriptedFetch([
    response(503),
    response(503),
    response(503),
    response(200, {})
  ]);
  const http = createProviderHttp({
    provider: 'isbndb',
    fetchImpl: fetch,
    metrics,
    sleep: async (ms) => sleeps.push(ms),
    random: () => 0.5,
    baseDelayMs: 100,
    maxDelayMs: 1_000
  });

  await expect(() => http.fetch('https://provider.test/x')).rejects.toSatisfy((error) => error.status === 503);

  expect(calls.length).toBe(MAX_ATTEMPTS);
  expect(sleeps).toEqual([75, 150]);
  expect(http.breaker.state, 'one failed request is below the threshold').toBe('closed');
  expect(http.breaker.failures).toBe(1);
});

test('honors Retry-After seconds and dates with a cap', async () => {
  expect(parseRetryAfter('2')).toBe(2_000);
  expect(parseRetryAfter('120')).toBe(10_000);
  expect(parseRetryAfter('garbage')).toBe(undefined);
  const now = Date.parse('2026-01-01T00:00:00Z');
  expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5_000);

  const sleeps = [];
  const { fetch, calls } = scriptedFetch([
    response(429, undefined, { 'retry-after': '2' }),
    response(200, {})
  ]);
  const http = createProviderHttp({
    provider: 'isbndb',
    fetchImpl: fetch,
    sleep: async (ms) => sleeps.push(ms),
    random: () => 0.5
  });
  await http.fetch('https://provider.test/x');
  expect(calls.length).toBe(2);
  expect(sleeps, 'Retry-After overrides exponential backoff').toEqual([2_000]);
});

test('opens the breaker after consecutive failures and skips the network', async () => {
  const metrics = createProviderMetrics();
  const { fetch, calls } = scriptedFetch([response(503), response(503), response(503)]);
  const http = createProviderHttp({
    provider: 'googlebooks',
    fetchImpl: fetch,
    metrics,
    sleep: async () => {},
    random: () => 0.5,
    failureThreshold: 1
  });

  await expect(() => http.fetch('https://provider.test/x')).rejects.toSatisfy((error) => error.status === 503);
  expect(calls.length).toBe(MAX_ATTEMPTS);
  expect(http.breaker.state).toBe('open');

  await expect(() => http.fetch('https://provider.test/x')).rejects.toSatisfy((error) =>
      error instanceof ProviderCircuitOpenError &&
      error.provider === 'googlebooks' &&
      error.status === 503);
  expect(calls.length, 'the open breaker performed no fetch').toBe(MAX_ATTEMPTS);

  const text = renderMetrics({ calls: 0, limit: 10, providerMetrics: metrics });
  expect(text).toMatch(/^bibliograph_provider_breaker_state\{provider="googlebooks"\} 2$/m);
  expect(text).toMatch(/^bibliograph_provider_requests_total\{provider="googlebooks",outcome="circuit_open"\} 1$/m);
});

test('half-open success closes the breaker', async () => {
  let clock = 0;
  const metrics = createProviderMetrics();
  const { fetch, calls } = scriptedFetch([response(503), response(200, {}), response(200, {})]);
  const http = createProviderHttp({
    provider: 'isbndb',
    fetchImpl: fetch,
    metrics,
    now: () => clock,
    sleep: async () => {},
    random: () => 0.5,
    maxAttempts: 1,
    failureThreshold: 1,
    cooldownMs: 1_000
  });

  await expect(() => http.fetch('https://provider.test/x')).rejects.toSatisfy((error) => error.status === 503);
  expect(http.breaker.state).toBe('open');

  clock = 500;
  await expect(() => http.fetch('https://provider.test/x')).rejects.toSatisfy((error) => error instanceof ProviderCircuitOpenError);
  expect(calls.length).toBe(1);

  clock = 1_000;
  const probe = await http.fetch('https://provider.test/x');
  expect(probe.status).toBe(200);
  expect(http.breaker.state).toBe('closed');
  expect(calls.length).toBe(2);

  await http.fetch('https://provider.test/x');
  expect(calls.length, 'a closed breaker fetches normally again').toBe(3);
});

test('half-open probe failure reopens the breaker', async () => {
  let clock = 0;
  const metrics = createProviderMetrics();
  const breaker = createCircuitBreaker({
    provider: 'goodreads',
    metrics,
    now: () => clock,
    failureThreshold: 1,
    cooldownMs: 1_000
  });

  breaker.fail(breaker.acquire());
  expect(breaker.state).toBe('open');

  clock = 1_000;
  const permit = breaker.acquire();
  expect(permit).toBe('probe');
  expect(breaker.state).toBe('half-open');
  expect(renderMetrics({ calls: 0, limit: 10, providerMetrics: metrics })).toMatch(/^bibliograph_provider_breaker_state\{provider="goodreads"\} 1$/m);

  breaker.fail(permit);
  expect(breaker.state).toBe('open');
  expect(() => breaker.acquire()).toThrow(ProviderCircuitOpenError)
});

test('trip() opens the breaker immediately and honors its cooldown', () => {
  let clock = 0;
  const breaker = createCircuitBreaker({
    provider: 'goodreads',
    now: () => clock,
    cooldownMs: 60_000
  });

  breaker.trip();
  expect(breaker.state).toBe('open');
  expect(() => breaker.acquire()).toThrow(ProviderCircuitOpenError)

  clock = 60_000;
  expect(breaker.canAttempt()).toEqual({ allowed: true, retryAfterMs: 0 });
});

test('breaker preflight is read-only and saves metered calls', () => {
  let clock = 0;
  const metrics = createProviderMetrics();
  const breaker = createCircuitBreaker({
    provider: 'isbndb',
    metrics,
    now: () => clock,
    failureThreshold: 1,
    cooldownMs: 1_000
  });

  breaker.fail(breaker.acquire());
  clock = 400;
  expect(breaker.canAttempt()).toEqual({ allowed: false, retryAfterMs: 600 });
  expect(() => breaker.assertCanAttempt()).toThrow(ProviderCircuitOpenError)
  expect(breaker.state, 'preflight never transitions the breaker').toBe('open');

  clock = 1_000;
  expect(breaker.canAttempt()).toEqual({ allowed: true, retryAfterMs: 0 });
  expect(breaker.state, 'preflight does not consume the half-open probe').toBe('open');

  const permit = breaker.acquire();
  expect(permit).toBe('probe');
  expect(breaker.state).toBe('half-open');
  expect(breaker.canAttempt(), 'a second half-open probe is blocked without consuming the first').toEqual({ allowed: false, retryAfterMs: 0 });

  breaker.succeed(permit);
  expect(breaker.canAttempt()).toEqual({ allowed: true, retryAfterMs: 0 });
});

test('a retry does not reserve extra ISBNdb daily quota', async () => {
  const pool = {
    queries: [],
    async query(sql, values) {
      this.queries.push({ sql, values });
      if (/INSERT INTO provider_daily_usage/.test(sql)) return { rows: [{ calls: 1 }] };
      return { rows: [] };
    }
  };
  const { fetch, calls } = scriptedFetch([
    response(503),
    response(200, { book: { title: 'Retry Book', isbn13: '9780306406157' } })
  ]);
  const http = createProviderHttp({
    provider: 'isbndb',
    fetchImpl: fetch,
    sleep: async () => {},
    random: () => 0.5
  });
  const isbndb = createIsbndb({
    pool,
    apiKey: 'test-key',
    baseUrl: 'https://provider.test/isbndb',
    dailyLimit: 100,
    fetchImpl: http.fetch,
    logger: silentLogger
  });

  const candidates = await isbndb.byIsbn('9780306406157');

  expect(calls.length, 'the network saw the retry').toBe(2);
  expect(pool.queries.filter((entry) => /INSERT INTO provider_daily_usage/.test(entry.sql)).length, 'quota is reserved once per provider query, not per attempt').toBe(1);
  expect(candidates[0].title).toBe('Retry Book');
});

test('provider fallback continues to Google when ISBNdb is open', async () => {
  const fetched = [];
  let reserves = 0;
  const pool = {
    async query(sql) {
      if (/INSERT INTO provider_daily_usage/.test(sql)) {
        reserves += 1;
        return { rows: [{ calls: reserves }] };
      }
      return { rows: [] };
    }
  };

  const providers = createProviders({
    pool,
    logger: silentLogger,
    env: {
      ISBNDB_API_KEY: 'test-key',
      ISBNDB_DAILY_LIMIT: '100',
      ISBNDB_BASE_URL: 'https://provider.test/isbndb',
      GOOGLE_BOOKS_BASE_URL: 'https://provider.test/google',
      OPENLIBRARY_BASE_URL: 'https://provider.test/openlibrary',
      GOODREADS_BASE_URL: 'https://provider.test/goodreads'
    },
    isbndbDailyLimit: 100,
    resilience: {
      sleep: async () => {},
      random: () => 0.5,
      failureThreshold: 1
    },
    fetchImpl: async (url) => {
      fetched.push(url);
      if (url.startsWith('https://provider.test/isbndb/')) return response(503);
      if (url.startsWith('https://provider.test/google/')) {
        return response(200, {
          totalItems: 1,
          items: [
            {
              id: 'fallback-volume',
              volumeInfo: {
                title: 'Fallback Book',
                industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780306406157' }]
              }
            }
          ]
        });
      }
      return response(404);
    }
  });

  const identifier = { issuer: 'isbn13', value: '9780306406157' };
  const first = await providers.resolve(identifier);
  expect(first.map((candidate) => candidate.title)).toEqual(['Fallback Book']);
  expect(providers.resilience.isbndb.state).toBe('open');
  expect(reserves, 'the failed request reserved one ISBNdb call').toBe(1);
  const reservesWhenOpen = reserves;
  const isbndbFetches = fetched.filter((url) => url.includes('/isbndb/')).length;
  expect(isbndbFetches).toBe(MAX_ATTEMPTS);

  const second = await providers.resolve(identifier);
  expect(second.map((candidate) => candidate.title)).toEqual(['Fallback Book']);
  expect(reserves, 'an open breaker reserves no ISBNdb quota').toBe(reservesWhenOpen);
  expect(fetched.filter((url) => url.includes('/isbndb/')).length, 'the open ISBNdb breaker never reached fetch').toBe(isbndbFetches);
});

test('renderMetrics includes provider labels, counters, and breaker state', async () => {
  const metrics = createProviderMetrics();
  const { fetch } = scriptedFetch([response(503), response(200, {})]);
  const http = createProviderHttp({
    provider: 'googlebooks',
    fetchImpl: fetch,
    metrics,
    sleep: async () => {},
    random: () => 0.5
  });
  await http.fetch('https://provider.test/x');

  const text = renderMetrics({ calls: 10, limit: 100, providerMetrics: metrics });

  expect(text).toMatch(/^# TYPE bibliograph_provider_attempts_total counter$/m);
  expect(text).toMatch(/^bibliograph_provider_attempts_total\{provider="googlebooks",attempt="1",outcome="retry"\} 1$/m);
  expect(text).toMatch(/^bibliograph_provider_attempts_total\{provider="googlebooks",attempt="2",outcome="success"\} 1$/m);
  expect(text).toMatch(/^bibliograph_provider_retries_total\{provider="googlebooks",reason="status_503"\} 1$/m);
  for (const provider of ['googlebooks', 'isbndb', 'openlibrary', 'goodreads']) {
    expect(text).toMatch(new RegExp(`^bibliograph_provider_breaker_state\\{provider="${provider}"\\} 0$`, 'm'));
  }
  expect(text).toMatch(/^bibliograph_isbndb_calls_today 10$/m);
});
