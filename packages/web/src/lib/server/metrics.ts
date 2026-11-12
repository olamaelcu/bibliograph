/**
 * Dependency-free Prometheus registry for the web edge.
 *
 * The endpoint is scraped directly on loopback (`127.0.0.1:5176/metrics`); the
 * public vhost denies that path (see packaging/web/nginx/bibliograph.conf). The
 * registry is deliberately tiny: counters, gauges, and histograms rendered in
 * the Prometheus text exposition format, with bounded label values chosen by
 * the recording helpers below rather than by callers.
 *
 * Memory grows with the number of distinct label tuples, so every helper
 * normalizes its input first: HTTP methods and statuses are mapped to fixed
 * sets, route ids come from SvelteKit's route manifest (a bounded list of
 * patterns, never the request URL), XRPC methods outside a known allowlist
 * collapse to `other`, and outcomes are fixed enumerations.
 */

export type Labels = Record<string, string>;

/** Standard latency buckets: sub-millisecond to ten seconds, plus +Inf. */
export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
] as const;

type Series = { readonly labels: [string, string][]; value: number };

type HistogramSeries = {
  readonly labels: [string, string][];
  /** Non-cumulative per-bucket counts, indexed like the histogram buckets. */
  readonly counts: number[];
  sum: number;
  count: number;
};

/** A label tuple's identity, stable regardless of the order keys were passed. */
function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}\u0000${labels[name]}`)
    .join('\u0001');
}

function entriesKey(labels: [string, string][]): string {
  return labels.map(([name, value]) => `${name}\u0000${value}`).join('\u0001');
}

/** Prometheus text format: backslash, double quote and newline are escaped. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** HELP text escapes backslashes and newlines only. */
function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '0';
  // `String` keeps integers bare and decimals in plain notation for the range
  // this process can produce (durations, byte counts, seconds).
  return String(value);
}

function labelText(labels: [string, string][]): string {
  if (labels.length === 0) return '';
  return `{${labels
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(',')}}`;
}

function family(kind: string, name: string, help: string, lines: string[]): string[] {
  return [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${kind}`, ...lines];
}

export class Counter {
  readonly name: string;
  readonly help: string;
  #series = new Map<string, Series>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) return;
    const key = seriesKey(labels);
    const existing = this.#series.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      this.#series.set(key, { labels: Object.entries(labels), value: amount });
    }
  }

  render(): string[] {
    const lines = [...this.#series.values()]
      .sort((a, b) => entriesKey(a.labels).localeCompare(entriesKey(b.labels)))
      .map((series) => `${this.name}${labelText(series.labels)} ${formatValue(series.value)}`);
    return family('counter', this.name, this.help, lines);
  }
}

export class Gauge {
  readonly name: string;
  readonly help: string;
  #series = new Map<string, Series>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(labels: Labels, value: number): void {
    const key = seriesKey(labels);
    const existing = this.#series.get(key);
    if (existing) {
      existing.value = value;
    } else {
      this.#series.set(key, { labels: Object.entries(labels), value });
    }
  }

  render(): string[] {
    const lines = [...this.#series.values()]
      .sort((a, b) => entriesKey(a.labels).localeCompare(entriesKey(b.labels)))
      .map((series) => `${this.name}${labelText(series.labels)} ${formatValue(series.value)}`);
    return family('gauge', this.name, this.help, lines);
  }
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  #series = new Map<string, HistogramSeries>();

  constructor(name: string, help: string, buckets: readonly number[] = DURATION_BUCKETS) {
    this.name = name;
    this.help = help;
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = seriesKey(labels);
    let series = this.#series.get(key);
    if (!series) {
      series = {
        labels: Object.entries(labels),
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0
      };
      this.#series.set(key, series);
    }

    series.sum += value;
    series.count += 1;
    // Buckets are cumulative in the exposition but stored incrementally: a
    // value at or below a boundary increments that bucket and every larger one.
    const first = this.buckets.findIndex((bound) => value <= bound);
    if (first === -1) return; // only +Inf is affected; it uses series.count
    for (let index = first; index < series.counts.length; index += 1) {
      series.counts[index] = (series.counts[index] ?? 0) + 1;
    }
  }

  render(): string[] {
    const lines: string[] = [];
    const series = [...this.#series.values()].sort((a, b) =>
      entriesKey(a.labels).localeCompare(entriesKey(b.labels))
    );
    for (const entry of series) {
      const base = entry.labels;
      for (const [index, bound] of this.buckets.entries()) {
        const labels: [string, string][] = [
          ...base,
          ['le', formatValue(bound)]
        ];
        lines.push(`${this.name}_bucket${labelText(labels)} ${entry.counts[index] ?? 0}`);
      }
      lines.push(`${this.name}_bucket${labelText([...base, ['le', '+Inf']])} ${entry.count}`);
      lines.push(`${this.name}_sum${labelText(base)} ${formatValue(entry.sum)}`);
      lines.push(`${this.name}_count${labelText(base)} ${entry.count}`);
    }
    return family('histogram', this.name, this.help, lines);
  }
}

export class Registry {
  #metrics: Array<Counter | Gauge | Histogram> = [];

  counter(name: string, help: string): Counter {
    const metric = new Counter(name, help);
    this.#metrics.push(metric);
    return metric;
  }

  gauge(name: string, help: string): Gauge {
    const metric = new Gauge(name, help);
    this.#metrics.push(metric);
    return metric;
  }

  histogram(name: string, help: string, buckets: readonly number[] = DURATION_BUCKETS): Histogram {
    const metric = new Histogram(name, help, buckets);
    this.#metrics.push(metric);
    return metric;
  }

  /** Prometheus text exposition, one trailing newline, stable family order. */
  render(): string {
    const lines = this.#metrics.flatMap((metric) => metric.render());
    return `${lines.join('\n')}\n`;
  }
}

// ---------------------------------------------------------------------------
// Bounded label normalization
// ---------------------------------------------------------------------------

const HTTP_METHODS: Record<string, true> = {
  GET: true,
  HEAD: true,
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
  OPTIONS: true
};

/** Fixed set of HTTP verbs; anything else (WebDAV, garbage) becomes `other`. */
export function normalizeHttpMethod(method: string): string {
  const upper = method.trim().toUpperCase();
  return HTTP_METHODS[upper] === true ? upper : 'other';
}

/**
 * A SvelteKit route id (`/`, `/admin`, `/xrpc/[...method]`, …) or
 * `unmatched` for a request that matched no route. Never a raw URL.
 */
export function normalizeRoute(routeId: string | null | undefined): string {
  return routeId === null || routeId === undefined || routeId === ''
    ? 'unmatched'
    : routeId;
}

/** Numeric HTTP status codes only; `0` marks a thrown upstream call. */
export function normalizeStatus(status: number): string {
  if (Number.isInteger(status) && status === 0) return '0';
  if (Number.isInteger(status) && status >= 100 && status <= 599) return String(status);
  return 'unknown';
}

/**
 * XRPC methods the edge is expected to see. Everything else is `other`, so a
 * caller cannot mint a new time series by inventing an NSID.
 */
const XRPC_METHODS: Record<string, true> = {
  'com.atproto.feed.describeFeedGenerator': true,
  'com.atproto.feed.getFeedSkeleton': true,
  'com.atproto.repo.applyWrites': true,
  'com.atproto.repo.describeRepo': true,
  'com.atproto.repo.getRecord': true,
  'com.atproto.repo.listRecords': true,
  'com.atproto.server.createSession': true,
  'com.atproto.server.describeServer': true,
  'com.atproto.sync.getBlocks': true,
  'com.atproto.sync.getLatestCommit': true,
  'com.atproto.sync.getRecord': true,
  'com.atproto.sync.getRepo': true,
  'com.atproto.sync.getRepoStatus': true,
  'com.atproto.sync.listRepos': true,
  'community.lexicon.media.book.resolveEditions': true,
  'community.lexicon.media.book.searchEditions': true,
  'net.olamaelcu.livtet.biblio.getContributor': true,
  'net.olamaelcu.livtet.biblio.getPublisher': true,
  'net.olamaelcu.livtet.biblio.graph.isFollowing': true,
  'net.olamaelcu.livtet.biblio.graph.listFollowees': true,
  'net.olamaelcu.livtet.biblio.listEditionsByContributor': true,
  'net.olamaelcu.livtet.biblio.listBooksOnShelf': true,
  'net.olamaelcu.livtet.biblio.listShelves': true,
  'net.olamaelcu.livtet.biblio.resolveContributors': true,
  'net.olamaelcu.livtet.biblio.resolvePublishers': true,
  'net.olamaelcu.livtet.biblio.searchContributors': true,
  'net.olamaelcu.livtet.biblio.searchPublishers': true
};

export function normalizeXrpcMethod(method: string): string {
  return XRPC_METHODS[method] === true ? method : 'other';
}

const CATALOG_OPERATIONS: Record<string, true> = {
  resolveEditions: true,
  searchEditions: true
};

export function normalizeCatalogOperation(operation: string): string {
  return CATALOG_OPERATIONS[operation] === true ? operation : 'other';
}

const PROXY_OUTCOMES: Record<string, true> = { ok: true, error: true, exception: true };

const FEED_KINDS: Record<string, true> = {
  public: true,
  following: true,
  extended: true,
  dynamic: true,
  describe: true,
  invalid: true
};

export function normalizeFeedKind(kind: string): string {
  return FEED_KINDS[kind] === true ? kind : 'other';
}

/** Fixed outcome names for feeds, derived from the response the edge returned. */
export function feedOutcomeForStatus(status: number): string {
  if (status >= 200 && status < 300) return 'ok';
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'auth_required';
    case 503:
      return 'unavailable';
    default:
      return 'error';
  }
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

/**
 * Every web metric family. `createWebMetrics` exists so tests can use a private
 * registry; the process-wide instance is `metrics`.
 */
export interface WebMetrics {
  readonly registry: Registry;
  readonly httpRequests: Counter;
  readonly httpRequestDuration: Histogram;
  readonly happyviewRequests: Counter;
  readonly pdsProxyRequests: Counter;
  readonly catalogQueries: Counter;
  readonly catalogQueryDuration: Histogram;
  readonly feedRequests: Counter;
  readonly processResidentMemory: Gauge;
  readonly processCpuSeconds: Gauge;
  readonly processUptime: Gauge;
  readonly nodejsHeapUsed: Gauge;
}

export function createWebMetrics(): WebMetrics {
  const registry = new Registry();
  return {
    registry,
    httpRequests: registry.counter(
      'bibliograph_http_requests_total',
      'HTTP requests served by the web edge, by method, matched route and status.'
    ),
    httpRequestDuration: registry.histogram(
      'bibliograph_http_request_duration_seconds',
      'Time spent serving an HTTP request, by method and matched route.'
    ),
    happyviewRequests: registry.counter(
      'bibliograph_happyview_requests_total',
      'XRPC calls proxied to HappyView, by normalized method, outcome and status.'
    ),
    pdsProxyRequests: registry.counter(
      'bibliograph_pds_proxy_requests_total',
      'Publisher-record reads proxied to the PDS, by normalized method, outcome and status.'
    ),
    catalogQueries: registry.counter(
      'bibliograph_catalog_queries_total',
      'Catalog database queries, by operation and outcome.'
    ),
    catalogQueryDuration: registry.histogram(
      'bibliograph_catalog_query_duration_seconds',
      'Time spent querying the catalog database, by operation.'
    ),
    feedRequests: registry.counter(
      'bibliograph_feed_requests_total',
      'Feed generator requests, by kind and outcome.'
    ),
    processResidentMemory: registry.gauge(
      'bibliograph_process_resident_memory_bytes',
      'Resident set size of the web process.'
    ),
    processCpuSeconds: registry.gauge(
      'bibliograph_process_cpu_seconds_total',
      'Total user and system CPU time spent by the web process, in seconds.'
    ),
    processUptime: registry.gauge(
      'bibliograph_process_uptime_seconds',
      'Time since the web process started, in seconds.'
    ),
    nodejsHeapUsed: registry.gauge(
      'bibliograph_nodejs_heap_used_bytes',
      'V8 heap used by the web process.'
    )
  };
}

/** Process-wide registry shared by hooks, the XRPC surface, and /metrics. */
export const metrics = createWebMetrics();

export function renderWebMetrics(m: WebMetrics = metrics): string {
  return m.registry.render();
}

/** Point the process gauges at the live process; called once per scrape. */
export function collectProcessMetrics(
  m: WebMetrics = metrics,
  source: Pick<NodeJS.Process, 'memoryUsage' | 'cpuUsage' | 'uptime'> = process
): void {
  const memory = source.memoryUsage();
  const cpu = source.cpuUsage();
  m.processResidentMemory.set({}, memory.rss);
  m.processCpuSeconds.set({}, (cpu.user + cpu.system) / 1_000_000);
  m.processUptime.set({}, source.uptime());
  m.nodejsHeapUsed.set({}, memory.heapUsed);
}

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

export function recordHttpRequest(
  m: WebMetrics,
  request: {
    method: string;
    /** `event.route.id`; `null` means the request matched no route. */
    route: string | null;
    status: number;
    durationSeconds: number;
  }
): void {
  const method = normalizeHttpMethod(request.method);
  const route = normalizeRoute(request.route);
  m.httpRequests.inc({ method, route, status: normalizeStatus(request.status) });
  m.httpRequestDuration.observe({ method, route }, request.durationSeconds);
}

function recordProxy(
  counter: Counter,
  request: { method: string; status: number; outcome?: 'ok' | 'error' | 'exception' }
): void {
  const outcome =
    request.outcome ?? (request.status >= 200 && request.status < 400 ? 'ok' : 'error');
  counter.inc({
    method: normalizeXrpcMethod(request.method),
    outcome: PROXY_OUTCOMES[outcome] === true ? outcome : 'error',
    status: normalizeStatus(request.status)
  });
}

export function recordHappyViewRequest(
  m: WebMetrics,
  request: { method: string; status: number; outcome?: 'ok' | 'error' | 'exception' }
): void {
  recordProxy(m.happyviewRequests, request);
}

export function recordPdsProxyRequest(
  m: WebMetrics,
  request: { method: string; status: number; outcome?: 'ok' | 'error' | 'exception' }
): void {
  recordProxy(m.pdsProxyRequests, request);
}

export function recordCatalogQuery(
  m: WebMetrics,
  operation: string,
  outcome: 'ok' | 'error' | 'unavailable',
  durationSeconds: number
): void {
  const normalized = normalizeCatalogOperation(operation);
  m.catalogQueries.inc({ operation: normalized, outcome });
  m.catalogQueryDuration.observe({ operation: normalized }, durationSeconds);
}

export function recordFeedRequest(m: WebMetrics, kind: string, status: number): void {
  m.feedRequests.inc({ kind: normalizeFeedKind(kind), outcome: feedOutcomeForStatus(status) });
}
