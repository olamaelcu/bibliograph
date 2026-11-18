/**
 * Dependency-free Prometheus endpoint for the catalog worker.
 *
 * ISBNdb quota gauges are read from Postgres on every scrape because the
 * database is the authoritative counter shared by all worker processes.
 * Provider retry/breaker counters live in memory and are passed in by the
 * worker that owns them.
 */

import http from 'node:http';

import { renderProviderMetrics } from './providers/resilience.js';
import { DEFAULT_LEASE_MS, MAX_ATTEMPTS, OUTBOX_COLLECTIONS } from './publish.js';
import { BOOKHIVE_ISSUER } from './bookhive.js';
import {
  DEFAULT_ISBNDB_DAILY_LIMIT,
  ISBNDB_SOFT_LIMIT_RATIO,
  readDailyCalls
} from './providers/usage.js';

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9464;

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
 * `ready` mirrors the claim predicate in publish.js (same collections, attempt
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
     WHERE collection = ANY($1::text[])
       AND ($4::text IS NULL OR starts_with(uri, 'at://' || $4 || '/'))`,
    [OUTBOX_COLLECTIONS, MAX_ATTEMPTS, leaseSeconds, publisherDid ?? null]
  );

  const row = result.rows[0] ?? {};
  return {
    ready: Math.trunc(nonNegative(row.ready)),
    parked: Math.trunc(nonNegative(row.parked)),
    oldestAgeSeconds: nonNegative(row.oldest_age_seconds)
  };
}

/**
 * The Bookhive count is a durable gauge, not a live one: one count per minute is
 * enough. The walk that moves it runs far slower than that, and a scrape every
 * 15 s multiplied by a count costing 0.7–1.4 s was pure waste on a 2-vCPU box.
 */
const BOOKHIVE_STATS_TTL_MS = 60_000;

/** Keyed on the pool object so a restarted worker starts cold. */
const bookhiveStatsCache = new WeakMap();

/**
 * How many catalog books Bookhive's hive ids currently name.
 *
 * One indexed count over `edition_identifiers`, refreshed at most once a
 * minute: the durable record of the import, independent of which process ran it
 * and across restarts. The issuer is a fixed token, so
 * `edition_identifiers_lookup_idx` serves the count.
 */
export async function readBookhiveStats(pool) {
  const cached = bookhiveStatsCache.get(pool);
  if (cached !== undefined && Date.now() - cached.at < BOOKHIVE_STATS_TTL_MS) return cached.value;

  const result = await pool.query(
    'SELECT count(*) AS editions FROM edition_identifiers WHERE issuer = $1',
    [BOOKHIVE_ISSUER]
  );
  const value = { editions: Math.trunc(nonNegative(result.rows[0]?.editions)) };
  bookhiveStatsCache.set(pool, { at: Date.now(), value });
  return value;
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

/**
 * Label values here are code-controlled tokens (`cached`, `rejected`, `retry`,
 * an HTTP status, `none`). Anything else is stripped, which keeps the exposition
 * valid without a general-purpose escaper.
 */
function labelValue(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '');
}

/**
 * What the Bookhive walk did in this process, one series per outcome.
 *
 * `result` is `run` (a walk started), `pages` (catalog pages fetched) or one of
 * the per-record outcomes (`created`, `updated`, `skipped`, `failed`). Every
 * label comes from `importBookhiveCatalog`'s own branches, so the series count
 * stays bounded. The totals restart with the process; the durable count is the
 * `bibliograph_catalog_bookhive_editions` gauge.
 */
function renderBookhiveMetrics(bookhiveMetrics) {
  const rows = bookhiveMetrics?.snapshot?.() ?? [];
  const lines = [
    '# HELP bibliograph_catalog_bookhive_total Bookhive catalog walk events since this process started, by result.',
    '# TYPE bibliograph_catalog_bookhive_total counter'
  ];
  for (const row of rows) {
    lines.push(
      `bibliograph_catalog_bookhive_total{result="${labelValue(row.result)}"} ` +
        `${Math.trunc(nonNegative(row.count))}`
    );
  }
  return lines.join('\n');
}

/**
 * Cover download outcomes, counted in memory by `catalog.covers`.
 *
 * `result` says what happened — `cached`, `rejected` (terminal, never retried)
 * or `retry` (the provider failed and graphile will try again) — and `status`
 * carries the HTTP status that decided it, or `none` when no response arrived.
 * The series count stays bounded because both labels come from this package's
 * own branches, not from response content.
 */
function renderCoverMetrics(coverMetrics) {
  const rows = coverMetrics?.snapshot?.() ?? [];
  const totals = coverMetrics?.counters?.() ?? { writes: 0, writeBytes: 0, removals: 0 };
  const lines = [
    '# HELP bibliograph_cover_downloads_total Cover image downloads attempted, by result and HTTP status.',
    '# TYPE bibliograph_cover_downloads_total counter'
  ];
  for (const row of rows) {
    lines.push(
      `bibliograph_cover_downloads_total{result="${labelValue(row.result)}",` +
        `status="${labelValue(row.status)}"} ${Math.trunc(nonNegative(row.count))}`
    );
  }
  // Files, not attempts: the cache's footprint on disk. `writes` is what the
  // `cached` outcome above also counts once per file; the byte total is the one
  // number no other series carries, and `removals` is what keeps the two honest.
  lines.push(
    '# HELP bibliograph_cover_writes_total Cover image files written to the cache.',
    '# TYPE bibliograph_cover_writes_total counter',
    `bibliograph_cover_writes_total ${Math.trunc(nonNegative(totals.writes))}`,
    '# HELP bibliograph_cover_write_bytes_total Bytes written to the cover cache.',
    '# TYPE bibliograph_cover_write_bytes_total counter',
    `bibliograph_cover_write_bytes_total ${Math.trunc(nonNegative(totals.writeBytes))}`,
    '# HELP bibliograph_cover_removals_total Cached cover files removed (a stale source or a re-download).',
    '# TYPE bibliograph_cover_removals_total counter',
    `bibliograph_cover_removals_total ${Math.trunc(nonNegative(totals.removals))}`
  );
  return lines.join('\n');
}

/** Render the Prometheus text exposition for quota, outbox and provider telemetry. */
export function renderMetrics({
  calls,
  limit = DEFAULT_ISBNDB_DAILY_LIMIT,
  providerMetrics,
  coverMetrics,
  bookhiveMetrics,
  bookhive = { editions: 0 },
  outbox = { ready: 0, parked: 0, oldestAgeSeconds: 0 },
  runtime = readProcessMetrics()
}) {
  const used = Number.isFinite(calls) && calls > 0 ? Math.trunc(calls) : 0;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0;
  const remaining = Math.max(0, cap - used);
  // Soft limit: where an alert should fire, 95% of the hard limit (4750 at the
  // default 5000). The hard limit stays what `createDailyQuota` enforces; the
  // counter it reserves from is the source of `calls` here.
  const softCap = Math.max(1, Math.floor(cap * ISBNDB_SOFT_LIMIT_RATIO));
  const softRemaining = Math.max(0, softCap - used);

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
    '# HELP bibliograph_isbndb_daily_soft_limit ISBNdb calls after which alerts should fire, below the hard daily limit.',
    '# TYPE bibliograph_isbndb_daily_soft_limit gauge',
    `bibliograph_isbndb_daily_soft_limit ${softCap}`,
    '# HELP bibliograph_isbndb_calls_remaining ISBNdb calls still available today (never negative).',
    '# TYPE bibliograph_isbndb_calls_remaining gauge',
    `bibliograph_isbndb_calls_remaining ${remaining}`,
    '# HELP bibliograph_isbndb_calls_remaining_soft ISBNdb calls available before the soft limit (never negative).',
    '# TYPE bibliograph_isbndb_calls_remaining_soft gauge',
    `bibliograph_isbndb_calls_remaining_soft ${softRemaining}`,
    '# HELP bibliograph_pds_outbox_ready Outbox rows claimable now (attempts < 10, due, unleased).',
    '# TYPE bibliograph_pds_outbox_ready gauge',
    `bibliograph_pds_outbox_ready ${Math.trunc(nonNegative(outbox.ready))}`,
    '# HELP bibliograph_pds_outbox_parked Outbox rows parked after exhausting their attempts.',
    '# TYPE bibliograph_pds_outbox_parked gauge',
    `bibliograph_pds_outbox_parked ${Math.trunc(nonNegative(outbox.parked))}`,
    '# HELP bibliograph_pds_outbox_oldest_age_seconds Age of the oldest claimable row, or 0 when none.',
    '# TYPE bibliograph_pds_outbox_oldest_age_seconds gauge',
    `bibliograph_pds_outbox_oldest_age_seconds ${nonNegative(outbox.oldestAgeSeconds)}`,
    '# HELP bibliograph_catalog_bookhive_editions Catalog books imported from Bookhive, counted by hive id.',
    '# TYPE bibliograph_catalog_bookhive_editions gauge',
    `bibliograph_catalog_bookhive_editions ${Math.trunc(nonNegative(bookhive.editions))}`,
    renderBookhiveMetrics(bookhiveMetrics),
    renderCoverMetrics(coverMetrics),
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
  coverMetrics,
  bookhiveMetrics,
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
      const [calls, outbox, bookhive] = await Promise.all([
        readDailyCalls(pool),
        readOutboxStats(pool, { publisherDid }),
        readBookhiveStats(pool)
      ]);
      response.writeHead(200, {
        'content-type': CONTENT_TYPE,
        'cache-control': 'no-store'
      });
      response.end(
        request.method === 'HEAD'
          ? undefined
          : renderMetrics({
              calls,
              limit,
              providerMetrics,
              coverMetrics,
              bookhiveMetrics,
              bookhive,
              outbox
            })
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
  coverMetrics,
  bookhiveMetrics,
  publisherDid,
  host,
  port,
  logger = console
} = {}) {
  const bindHost = (host ?? process.env.WORKER_METRICS_HOST ?? '').trim() || DEFAULT_HOST;
  const bindPort = parseMetricsPort(port ?? process.env.WORKER_METRICS_PORT, logger);
  const server = createMetricsServer({
    pool,
    limit,
    providerMetrics,
    coverMetrics,
    bookhiveMetrics,
    publisherDid,
    logger
  });

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
