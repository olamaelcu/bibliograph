/**
 * Dependency-free Prometheus endpoint for the catalog worker.
 *
 * The only metric family today is the ISBNdb daily quota. Values are read from
 * Postgres on every scrape, because the database is the authoritative counter
 * shared by all worker processes.
 */

import http from 'node:http';

import { DEFAULT_ISBNDB_DAILY_LIMIT, readDailyCalls } from './providers/usage.js';

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9464;

export { DEFAULT_HOST as DEFAULT_METRICS_HOST, DEFAULT_PORT as DEFAULT_METRICS_PORT };

/** Render the Prometheus text exposition for an ISBNdb quota snapshot. */
export function renderMetrics({ calls, limit }) {
  const used = Number.isFinite(calls) && calls > 0 ? Math.trunc(calls) : 0;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0;
  const remaining = Math.max(0, cap - used);

  return [
    '# HELP bibliograph_isbndb_calls_today ISBNdb calls reserved for the current UTC day.',
    '# TYPE bibliograph_isbndb_calls_today gauge',
    `bibliograph_isbndb_calls_today ${used}`,
    '# HELP bibliograph_isbndb_daily_limit Configured ISBNdb calls allowed per UTC day.',
    '# TYPE bibliograph_isbndb_daily_limit gauge',
    `bibliograph_isbndb_daily_limit ${cap}`,
    '# HELP bibliograph_isbndb_calls_remaining ISBNdb calls still available today (never negative).',
    '# TYPE bibliograph_isbndb_calls_remaining gauge',
    `bibliograph_isbndb_calls_remaining ${remaining}`,
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
export function createMetricsServer({ pool, limit = DEFAULT_ISBNDB_DAILY_LIMIT, logger = console } = {}) {
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
      const calls = await readDailyCalls(pool);
      response.writeHead(200, {
        'content-type': CONTENT_TYPE,
        'cache-control': 'no-store'
      });
      response.end(request.method === 'HEAD' ? undefined : renderMetrics({ calls, limit }));
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
export async function startMetricsServer({ pool, limit = DEFAULT_ISBNDB_DAILY_LIMIT, host, port, logger = console } = {}) {
  const bindHost = (host ?? process.env.WORKER_METRICS_HOST ?? '').trim() || DEFAULT_HOST;
  const bindPort = parseMetricsPort(port ?? process.env.WORKER_METRICS_PORT, logger);
  const server = createMetricsServer({ pool, limit, logger });

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
