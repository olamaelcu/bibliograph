import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMetricsServer,
  readOutboxStats,
  readProcessMetrics,
  renderMetrics
} from '../lib/metrics.js';
import { MAX_ATTEMPTS, OUTBOX_COLLECTION } from '../lib/publish.js';

/**
 * The worker scrape owns the outbox backlog gauges: one aggregate query that
 * mirrors the claim predicate, rendered alongside the unchanged quota and
 * provider families. A fake pool pins the SQL contract and the coercion of
 * Postgres count/numeric values (which arrive as strings).
 */

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

const EMPTY = { ready: 0, parked: 0, oldestAgeSeconds: 0 };

test('renders worker liveness and outbox gauges with the existing families', () => {
  const text = renderMetrics({
    calls: 10,
    limit: 100,
    outbox: { ready: 4, parked: 2, oldestAgeSeconds: 90.5 },
    runtime: {
      residentMemoryBytes: 1_048_576,
      cpuSeconds: 1.5,
      uptimeSeconds: 60,
      heapUsedBytes: 524_288
    }
  });

  for (const [name, type] of [
    ['bibliograph_worker_up', 'gauge'],
    ['bibliograph_process_resident_memory_bytes', 'gauge'],
    ['bibliograph_process_cpu_seconds_total', 'gauge'],
    ['bibliograph_process_uptime_seconds', 'gauge'],
    ['bibliograph_nodejs_heap_used_bytes', 'gauge'],
    ['bibliograph_isbndb_calls_today', 'gauge'],
    ['bibliograph_isbndb_daily_limit', 'gauge'],
    ['bibliograph_isbndb_calls_remaining', 'gauge'],
    ['bibliograph_pds_outbox_ready', 'gauge'],
    ['bibliograph_pds_outbox_parked', 'gauge'],
    ['bibliograph_pds_outbox_oldest_age_seconds', 'gauge'],
    ['bibliograph_provider_attempts_total', 'counter'],
    ['bibliograph_provider_retries_total', 'counter'],
    ['bibliograph_provider_requests_total', 'counter'],
    ['bibliograph_provider_breaker_state', 'gauge']
  ]) {
    assert.match(text, new RegExp(`^# HELP ${name} .+$`, 'm'));
    assert.match(text, new RegExp(`^# TYPE ${name} ${type}$`, 'm'));
  }

  assert.match(text, /^bibliograph_worker_up 1$/m);
  assert.match(text, /^bibliograph_process_resident_memory_bytes 1048576$/m);
  assert.match(text, /^bibliograph_process_cpu_seconds_total 1\.5$/m);
  assert.match(text, /^bibliograph_process_uptime_seconds 60$/m);
  assert.match(text, /^bibliograph_nodejs_heap_used_bytes 524288$/m);
  assert.match(text, /^bibliograph_isbndb_calls_today 10$/m);
  assert.match(text, /^bibliograph_isbndb_calls_remaining 90$/m);
  assert.match(text, /^bibliograph_pds_outbox_ready 4$/m);
  assert.match(text, /^bibliograph_pds_outbox_parked 2$/m);
  assert.match(text, /^bibliograph_pds_outbox_oldest_age_seconds 90\.5$/m);
});

test('missing outbox stats render as zero rather than NaN', () => {
  const text = renderMetrics({
    calls: 0,
    limit: 10,
    runtime: { residentMemoryBytes: 0, cpuSeconds: 0, uptimeSeconds: 0, heapUsedBytes: 0 }
  });
  assert.match(text, /^bibliograph_pds_outbox_ready 0$/m);
  assert.match(text, /^bibliograph_pds_outbox_parked 0$/m);
  assert.match(text, /^bibliograph_pds_outbox_oldest_age_seconds 0$/m);
});

test('process gauges are read live from a process-like source', () => {
  const runtime = readProcessMetrics({
    memoryUsage: () => ({ rss: 2_097_152, heapUsed: 1_048_576 }),
    cpuUsage: () => ({ user: 1_500_000, system: 500_000 }),
    uptime: () => 42.25
  });

  assert.deepEqual(runtime, {
    residentMemoryBytes: 2_097_152,
    cpuSeconds: 2,
    uptimeSeconds: 42.25,
    heapUsedBytes: 1_048_576
  });
});

test('the outbox aggregate mirrors the claim predicate and coerces pg strings', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ ready: '3', parked: '2', oldest_age_seconds: '42.5' }] };
    }
  };

  const stats = await readOutboxStats(pool, { publisherDid: 'did:web:test.example' });

  assert.deepEqual(stats, { ready: 3, parked: 2, oldestAgeSeconds: 42.5 });
  assert.equal(calls.length, 1);
  const [{ sql, values }] = calls;
  assert.match(sql, /FROM pds_outbox/);
  assert.match(sql, /attempts < \$2/);
  assert.match(sql, /next_at <= now\(\)/);
  assert.match(sql, /make_interval\(secs => \$3\)/);
  assert.match(sql, /starts_with\(uri, 'at:\/\/' \|\| \$4 \|\| '\/'\)/);
  assert.deepEqual(values, [OUTBOX_COLLECTION, MAX_ATTEMPTS, 300, 'did:web:test.example']);
});

test('malformed aggregate values never become NaN or negative gauges', async () => {
  const stats = await readOutboxStats(
    { query: async () => ({ rows: [{ ready: 'n/a', parked: '-4', oldest_age_seconds: null }] }) },
    {}
  );
  assert.deepEqual(stats, EMPTY);

  const empty = await readOutboxStats({ query: async () => ({ rows: [] }) }, {});
  assert.deepEqual(empty, EMPTY);
});

test('the metrics endpoint renders the outbox aggregate', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('pds_outbox')) {
        return { rows: [{ ready: '5', parked: '1', oldest_age_seconds: '12' }] };
      }
      return { rows: [{ calls: 7 }] };
    }
  };

  const server = createMetricsServer({
    pool,
    limit: 10,
    publisherDid: 'did:web:test.example',
    logger: silentLogger
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    const body = await response.text();
    assert.match(body, /^bibliograph_worker_up 1$/m);
    assert.match(body, /^bibliograph_process_resident_memory_bytes \d+$/m);
    assert.match(body, /^bibliograph_process_cpu_seconds_total \d+(\.\d+)?$/m);
    assert.match(body, /^bibliograph_process_uptime_seconds \d+(\.\d+)?$/m);
    assert.match(body, /^bibliograph_nodejs_heap_used_bytes \d+$/m);
    assert.match(body, /^bibliograph_pds_outbox_ready 5$/m);
    assert.match(body, /^bibliograph_pds_outbox_parked 1$/m);
    assert.match(body, /^bibliograph_pds_outbox_oldest_age_seconds 12$/m);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
