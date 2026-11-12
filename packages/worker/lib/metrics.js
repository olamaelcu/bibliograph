/**
 * Dependency-free Prometheus endpoint for the catalog worker.
 *
 * ISBNdb quota gauges are read from Postgres on every scrape because the
 * database is the authoritative counter shared by all worker processes.
 * Provider retry/breaker counters live in memory and are passed in by the
 * worker that owns them.
 */

import http from 'node:http';

import { DEFAULT_ISBNDB_DAILY_LIMIT, readDailyCalls } from './providers/usage.js';
import { renderProviderMetrics } from './providers/resilience.js';
import { DEFAULT_LEASE_MS, MAX_ATTEMPTS, OUTBOX_COLLECTION } from './publish.js';

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9464;

export { DEFAULT_HOST as DEFAULT_METRICS_HOST, DEFAULT_PORT as DEFAULT_METRICS_PORT };

/**
 * Coerce a Postgres numeric (returned as a string for bigint/numeric) to a
 * non-negative JS number. Missing or malformed values become 0 so a scrape
 * renders sentinels instead of `NaN`.
 */
function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Aggregate the pds_outbox backlog for one scrape.
 *
 * `ready` mirrors the claim predicate in publish.js (same collection, attempt
 * cap, due time and lease), so it counts exactly the rows the next drain could
 * pick up. `parked` counts rows that exhausted MAX_ATTEMPTS and are only
 * visible to an operator. One aggregate query over the partial ready index;
 * no per-row labels.
 */
export async function readOutboxStats(pool, { publisherDid, leaseMs = DEFAULT_LEASE_MS } = {}) {
  const leaseSeconds = Math.max(1, Math.ceil(leaseMs / 1000));
  const result = await pool.query(
    `SELECT
       count(*) FILTER (
         WHERE attempts < $2
           AND next_at <= now()
           AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $3))
       ) AS ready,
       count(*) FILTER (WHERE attempts >= $2) AS parked,
       COALESCE(EXTRACT(EPOCH FROM (
         now() - min(next_at) FILTER (
           WHERE attempts < $2
             AND next_at <= now()
             AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $3))
         )
       )), 0) AS oldest_age_seconds
     FROM pds_outbox
     WHERE collection = $1
       AND ($4::text IS NULL OR starts_with(uri, 'at://' || $4 || '/'))`,
    [OUTBOX_COLLECTION, MAX_ATTEMPTS, leaseSeconds, publisherDid ?? null]
  );

  const row = result.rows[0] ?? {};
  return {
    ready: Math.trunc(nonNegative(row.ready)),
    parked: Math.trunc(nonNegative(row.parked)),
    oldestAgeSeconds: nonNegative(row.oldest_age_seconds)
  };
}

/**
 * Process gauges for one scrape. Read live (not cached) so uptime, CPU and
 * memory reflect the worker at scrape time; injectable for tests.
 */
export function readProcessMetrics(source = process) {
  const memory = source.memoryUsage();
  const cpu = source.cpuUsage();
  return {
    residentMemoryBytes: nonNegative(memory.rss),
    cpuSeconds: nonNegative((cpu.user + cpu.system) / 1_000_000),
    uptimeSeconds: nonNegative(source.uptime()),
    heapUsedBytes: nonNegative(memory.heapUsed)
  };
}

/** Render the Prometheus text exposition for quota, outbox and provider telemetry. */
export function renderMetrics({
  calls,
  limit,
  providerMetrics,
  outbox = { ready: 0, parked: 0, oldestAgeSeconds: 0 },
  runtime = readProcessMetrics()
}) {
  const used = Number.isFinite(calls) && calls > 0 ? Math.trunc(calls) : 0;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0;
  const remaining = Math.max(0, cap - used);

  return [
    '# HELP bibliograph_worker_up Whether this worker process is answering scrapes.',
    '# TYPE bibliograph_worker_up gauge',
    'bibliograph_worker_up 1',
    '# HELP bibliograph_process_resident_memory_bytes Resident set size of the worker process.',
    '# TYPE bibliograph_process_resident_memory_bytes gauge',
    `bibliograph_process_resident_memory_bytes ${nonNegative(runtime.residentMemoryBytes)}`,
    '# HELP bibliograph_process_cpu_seconds_total Total user and system CPU time spent by the worker process, in seconds.',
    '# TYPE bibliograph_process_cpu_seconds_total gauge',
    `bibliograph_process_cpu_seconds_total ${nonNegative(runtime.cpuSeconds)}`,
    '# HELP bibliograph_process_uptime_seconds Time since the worker process started, in seconds.',
    '# TYPE bibliograph_process_uptime_seconds gauge',
    `bibliograph_process_uptime_seconds ${nonNegative(runtime.uptimeSeconds)}`,
    '# HELP bibliograph_nodejs_heap_used_bytes V8 heap used by the worker process.',
    '# TYPE bibliograph_nodejs_heap_used_bytes gauge',
    `bibliograph_nodejs_heap_used_bytes ${nonNegative(runtime.heapUsedBytes)}`,
    '# HELP bibliograph_isbndb_calls_today ISBNdb calls reserved for the current UTC day.',
    '# TYPE bibliograph_isbndb_calls_today gauge',
    `bibliograph_isbndb_calls_today ${used}`,
    '# HELP bibliograph_isbndb_daily_limit Configured ISBNdb calls allowed per UTC day.',
    '# TYPE bibliograph_isbndb_daily_limit gauge',
    `bibliograph_isbndb_daily_limit ${cap}`,
    '# HELP bibliograph_isbndb_calls_remaining ISBNdb calls still available today (never negative).',
    '# TYPE bibliograph_isbndb_calls_remaining gauge',
    `bibliograph_isbndb_calls_remaining ${remaining}`,
    '# HELP bibliograph_pds_outbox_ready Outbox rows claimable now (attempts < 10, due, unleased).',
    '# TYPE bibliograph_pds_outbox_ready gauge',
    `bibliograph_pds_outbox_ready ${Math.trunc(nonNegative(outbox.ready))}`,
    '# HELP bibliograph_pds_outbox_parked Outbox rows parked after exhausting their attempts.',
    '# TYPE bibliograph_pds_outbox_parked gauge',
    `bibliograph_pds_outbox_parked ${Math.trunc(nonNegative(outbox.parked))}`,
    '# HELP bibliograph_pds_outbox_oldest_age_seconds Age of the oldest claimable row, or 0 when none.',
    '# TYPE bibliograph_pds_outbox_oldest_age_seconds gauge',
    `bibliograph_pds_outbox_oldest_age_seconds ${nonNegative(outbox.oldestAgeSeconds)}`,
    renderProviderMetrics(providerMetrics),
    ''
  ].join('\n');
}

export function parseMetricsPort(raw, logger = console) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (Number.isInteger(port) && port >= 0 && port <= 65535) return port;
  logger?.warn?.(
    `worker: WORKER_METRICS_PORT=${JSON.stringify(String(raw))} is not a valid port; ` +
      `using ${DEFAULT_PORT}`
  );
  return DEFAULT_PORT;
}

/**
 * Build the HTTP server without listening, so tests can bind port 0 and the
 * caller owns startup/shutdown.
 */
export function createMetricsServer({
  pool,
  limit = DEFAULT_ISBNDB_DAILY_LIMIT,
  providerMetrics,
  publisherDid,
  logger = console
} = {}) {
  if (!pool) throw new Error('createMetricsServer requires a Postgres pool');

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/metrics') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, {
        'content-type': 'text/plain; charset=utf-8',
        allow: 'GET, HEAD'
      });
      response.end('method not allowed\n');
      return;
    }

    try {
      const [calls, outbox] = await Promise.all([
        readDailyCalls(pool),
        readOutboxStats(pool, { publisherDid })
      ]);
      response.writeHead(200, {
        'content-type': CONTENT_TYPE,
        'cache-control': 'no-store'
      });
      response.end(
        request.method === 'HEAD'
          ? undefined
          : renderMetrics({ calls, limit, providerMetrics, outbox })
      );
    } catch (error) {
      // A metrics scrape must never take the worker down; report the failure to
      // the scraper instead of serving misleading counters.
      logger?.error?.(`worker: metrics query failed: ${error.message}`);
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('metrics unavailable\n');
    }
  });
}

/**
 * Start the metrics server. Resolves to the listening server; the caller closes
 * it on shutdown.
 */
export async function startMetricsServer({
  pool,
  limit = DEFAULT_ISBNDB_DAILY_LIMIT,
  providerMetrics,
  publisherDid,
  host,
  port,
  logger = console
} = {}) {
  const bindHost = (host ?? process.env.WORKER_METRICS_HOST ?? '').trim() || DEFAULT_HOST;
  const bindPort = parseMetricsPort(port ?? process.env.WORKER_METRICS_PORT, logger);
  const server = createMetricsServer({ pool, limit, providerMetrics, publisherDid, logger });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(bindPort, bindHost);
  });

  server.on('error', (error) => {
    logger?.error?.(`worker: metrics server error: ${error.message}`);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : bindPort;
  logger?.log?.(`worker: metrics listening on http://${bindHost}:${actualPort}/metrics`);
  return server;
}
