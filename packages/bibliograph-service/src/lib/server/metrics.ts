import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

// Track XRPC responses that return contributors with empty/invalid names
// (e.g. name === '' which violates lexicon minLength: 1)
export const invalidContributorResponsesTotal = new Counter({
  name: 'invalid_contributor_responses_total',
  help: 'Number of search XRPC responses with invalid contributor names',
  labelNames: ['nsid', 'reason'] as const,
  registers: [metricsRegistry],
});

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
export const searchProviderRequestsTotal = new Counter({
  name: 'search_provider_requests_total',
  help: 'Search requests to upstream providers',
  labelNames: ['provider', 'status'] as const,
  registers: [metricsRegistry],
});

// Google Books response cache. `hit`/`negative` are requests served without
// touching upstream (negative = a remembered "no such volume"); `store` counts
// the writes that make those possible; `error` is a cache failure that was
// swallowed so the request fell through to upstream.
export const googleBooksCacheTotal = new Counter({
  name: 'google_books_cache_total',
  help: 'Google Books response cache lookups and stores',
  labelNames: ['result'] as const,
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

// TAP ingestion health. These three were invisible while ingestion wedged for
// 14 minutes: acks failing is the symptom of the read loop stalling, enqueue
// failures are records TAP has to redeliver, and duplicates are the price of
// at-least-once delivery that the batch tasks now collapse before writing.
export const tapAckFailuresTotal = new Counter({
  name: 'tap_ack_failures_total',
  help: 'TAP event acks that failed and will be redelivered',
  registers: [metricsRegistry],
});

export const tapEnqueueFailuresTotal = new Counter({
  name: 'tap_enqueue_failures_total',
  help: 'TAP batches that could not be written to graphile_worker and stay unacked for redelivery',
  labelNames: ['task'] as const,
  registers: [metricsRegistry],
});

export const tapDuplicateEventsTotal = new Counter({
  name: 'tap_duplicate_events_total',
  help: 'TAP events collapsed by uri inside one batch',
  labelNames: ['stage'] as const,
  registers: [metricsRegistry],
});

// How far behind the consumer is, in TAP's own terms. `/channel` has no cursor,
// so this is the only number that says whether events are waiting on us; the
// 14-minute stall showed 2,863 here while nothing else moved.
export const tapOutboxBuffer = new Gauge({
  name: 'tap_outbox_buffer',
  help: 'Events TAP still holds unacknowledged for this consumer',
  registers: [metricsRegistry],
});

export const tapResyncBuffer = new Gauge({
  name: 'tap_resync_buffer',
  help: 'Repos TAP still has queued for resync',
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
    .replace(/\/(did:[a-z0-9:.-]+)/gi, '/{did}')
    .replace(/\/[a-z0-9]{16,}/gi, '/{id}')
    .replace(/\/\d+/g, '/{id}');
}