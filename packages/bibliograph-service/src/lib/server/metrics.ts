import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const searchRequestsTotal = new Counter({
  name: 'search_requests_total',
  help: 'Number of search XRPC requests handled',
  labelNames: ['nsid', 'status'] as const,
  registers: [metricsRegistry],
});

export const upstreamRequestsTotal = new Counter({
  name: 'upstream_requests_total',
  help: 'Number of upstream API requests',
  labelNames: ['upstream', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const searchLatencyMs = new Histogram({
  name: 'search_latency_ms',
  help: 'Search XRPC handler latency in ms',
  labelNames: ['nsid'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [metricsRegistry],
});

export const upstreamLatencyMs = new Histogram({
  name: 'upstream_latency_ms',
  help: 'Upstream API call latency in ms',
  labelNames: ['upstream'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [metricsRegistry],
});

export const httpRequestDurationMs = new Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in ms',
  labelNames: ['method', 'status', 'path'] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [metricsRegistry],
});

/**
 * Collapse high-cardinality path segments (DIDs, rkeys, opaque IDs) to
 * placeholders so a single label value doesn't generate unbounded time series.
 * Keep `/xrpc/{nsid}` and `/.well-known/*` paths verbatim — they're bounded by
 * the lexicon count, not user input.
 */
export function normalizePath(pathname: string): string {
  if (pathname.startsWith('/xrpc/') || pathname.startsWith('/.well-known/')) {
    return pathname;
  }
  return pathname
    .replace(/\/(did:[a-z0-9:]+)/gi, '/{did}')
    .replace(/\/[a-z0-9]{16,}/gi, '/{id}')
    .replace(/\/\d+/g, '/{id}');
}