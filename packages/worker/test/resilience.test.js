import test from 'node:test';
import assert from 'node:assert/strict';

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

  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(http.breaker.state, 'closed');
  const snapshot = metrics.snapshot();
  assert.ok(
    snapshot.attempts.some(
      (row) =>
        row.provider === 'googlebooks' &&
        row.attempt === 1 &&
        row.outcome === 'retry' &&
        row.count === 1
    )
  );
  assert.ok(
    snapshot.attempts.some(
      (row) =>
        row.provider === 'googlebooks' &&
        row.attempt === 2 &&
        row.outcome === 'success' &&
        row.count === 1
    )
  );
  assert.deepEqual(snapshot.retries, [
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
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);

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

    assert.equal(result.status, status);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(http.breaker.state, 'closed');
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.retries.length, 0);
    assert.ok(
      snapshot.requests.some(
        (row) => row.provider === 'googlebooks' && row.outcome !== 'error'
      )
    );
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

  await assert.rejects(
    () => http.fetch('https://provider.test/x'),
    (error) => error.status === 503
  );

  assert.equal(calls.length, MAX_ATTEMPTS);
  assert.deepEqual(sleeps, [75, 150]);
  assert.equal(http.breaker.state, 'closed', 'one failed request is below the threshold');
  assert.equal(http.breaker.failures, 1);
});

test('honors Retry-After seconds and dates with a cap', async () => {
  assert.equal(parseRetryAfter('2'), 2_000);
  assert.equal(parseRetryAfter('120'), 10_000);
  assert.equal(parseRetryAfter('garbage'), undefined);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5_000);

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
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2_000], 'Retry-After overrides exponential backoff');
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

  await assert.rejects(
    () => http.fetch('https://provider.test/x'),
    (error) => error.status === 503
  );
  assert.equal(calls.length, MAX_ATTEMPTS);
  assert.equal(http.breaker.state, 'open');

  await assert.rejects(
    () => http.fetch('https://provider.test/x'),
    (error) =>
      error instanceof ProviderCircuitOpenError &&
      error.provider === 'googlebooks' &&
      error.status === 503
  );
  assert.equal(calls.length, MAX_ATTEMPTS, 'the open breaker performed no fetch');

  const text = renderMetrics({ calls: 0, limit: 10, providerMetrics: metrics });
  assert.match(text, /^bibliograph_provider_breaker_state\{provider="googlebooks"\} 2$/m);
  assert.match(
    text,
    /^bibliograph_provider_requests_total\{provider="googlebooks",outcome="circuit_open"\} 1$/m
  );
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

  await assert.rejects(
    () => http.fetch('https://provider.test/x'),
    (error) => error.status === 503
  );
  assert.equal(http.breaker.state, 'open');

  clock = 500;
  await assert.rejects(
    () => http.fetch('https://provider.test/x'),
    (error) => error instanceof ProviderCircuitOpenError
  );
  assert.equal(calls.length, 1);

  clock = 1_000;
  const probe = await http.fetch('https://provider.test/x');
  assert.equal(probe.status, 200);
  assert.equal(http.breaker.state, 'closed');
  assert.equal(calls.length, 2);

  await http.fetch('https://provider.test/x');
  assert.equal(calls.length, 3, 'a closed breaker fetches normally again');
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
  assert.equal(breaker.state, 'open');

  clock = 1_000;
  const permit = breaker.acquire();
  assert.equal(permit, 'probe');
  assert.equal(breaker.state, 'half-open');
  assert.match(
    renderMetrics({ calls: 0, limit: 10, providerMetrics: metrics }),
    /^bibliograph_provider_breaker_state\{provider="goodreads"\} 1$/m
  );

  breaker.fail(permit);
  assert.equal(breaker.state, 'open');
  assert.throws(() => breaker.acquire(), ProviderCircuitOpenError);
});

test('trip() opens the breaker immediately and honors its cooldown', () => {
  let clock = 0;
  const breaker = createCircuitBreaker({
    provider: 'goodreads',
    now: () => clock,
    cooldownMs: 60_000
  });

  breaker.trip();
  assert.equal(breaker.state, 'open');
  assert.throws(() => breaker.acquire(), ProviderCircuitOpenError);

  clock = 60_000;
  assert.deepEqual(breaker.canAttempt(), { allowed: true, retryAfterMs: 0 });
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
  assert.deepEqual(breaker.canAttempt(), { allowed: false, retryAfterMs: 600 });
  assert.throws(() => breaker.assertCanAttempt(), ProviderCircuitOpenError);
  assert.equal(breaker.state, 'open', 'preflight never transitions the breaker');

  clock = 1_000;
  assert.deepEqual(breaker.canAttempt(), { allowed: true, retryAfterMs: 0 });
  assert.equal(breaker.state, 'open', 'preflight does not consume the half-open probe');

  const permit = breaker.acquire();
  assert.equal(permit, 'probe');
  assert.equal(breaker.state, 'half-open');
  assert.deepEqual(
    breaker.canAttempt(),
    { allowed: false, retryAfterMs: 0 },
    'a second half-open probe is blocked without consuming the first'
  );

  breaker.succeed(permit);
  assert.deepEqual(breaker.canAttempt(), { allowed: true, retryAfterMs: 0 });
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

  assert.equal(calls.length, 2, 'the network saw the retry');
  assert.equal(
    pool.queries.filter((entry) => /INSERT INTO provider_daily_usage/.test(entry.sql)).length,
    1,
    'quota is reserved once per provider query, not per attempt'
  );
  assert.equal(candidates[0].title, 'Retry Book');
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
  assert.deepEqual(first.map((candidate) => candidate.title), ['Fallback Book']);
  assert.equal(providers.resilience.isbndb.state, 'open');
  assert.equal(reserves, 1, 'the failed request reserved one ISBNdb call');
  const reservesWhenOpen = reserves;
  const isbndbFetches = fetched.filter((url) => url.includes('/isbndb/')).length;
  assert.equal(isbndbFetches, MAX_ATTEMPTS);

  const second = await providers.resolve(identifier);
  assert.deepEqual(second.map((candidate) => candidate.title), ['Fallback Book']);
  assert.equal(reserves, reservesWhenOpen, 'an open breaker reserves no ISBNdb quota');
  assert.equal(
    fetched.filter((url) => url.includes('/isbndb/')).length,
    isbndbFetches,
    'the open ISBNdb breaker never reached fetch'
  );
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

  assert.match(text, /^# TYPE bibliograph_provider_attempts_total counter$/m);
  assert.match(
    text,
    /^bibliograph_provider_attempts_total\{provider="googlebooks",attempt="1",outcome="retry"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_provider_attempts_total\{provider="googlebooks",attempt="2",outcome="success"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_provider_retries_total\{provider="googlebooks",reason="status_503"\} 1$/m
  );
  for (const provider of ['googlebooks', 'isbndb', 'openlibrary', 'goodreads']) {
    assert.match(
      text,
      new RegExp(`^bibliograph_provider_breaker_state\\{provider="${provider}"\\} 0$`, 'm')
    );
  }
  assert.match(text, /^bibliograph_isbndb_calls_today 10$/m);
});
