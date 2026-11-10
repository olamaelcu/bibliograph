import type { Logger } from 'pino';

/**
 * One transport for every outbound HTTP call.
 *
 * The timeout is why this module exists. The request path fans out to Google
 * Books, ISBNdb, Wikidata, Wikimedia and Constellation, and each provider used
 * to carry its own 5-15s default: a hung provider held the whole XRPC response
 * for that long instead of failing fast. Three seconds sits above every
 * provider's measured p95 from this host (Google Books ~130ms, ISBNdb ~150ms),
 * so a call that trips it is already an outlier, and failing it lets the breaker
 * and the caller's own fallback do their job.
 *
 * Callers keep owning retries, breakers, caching and metrics: those differ per
 * provider. The transport owns the timeout, the user agent, and turning HTTP
 * status into an error the retry layer can classify.
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 3_000;

export const HTTP_USER_AGENT = 'Bibliograph/0.1 (+https://biblio.livtet.olamaelcu.net)';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Passed to fetch; the Goodreads scraper reads redirects and cookies by hand. */
  redirect?: RequestRedirect;
  /**
   * Overrides `DEFAULT_HTTP_TIMEOUT_MS`. Only for calls that are not on a
   * request path (bulk backfills, catalog pagination); the default is what
   * bounds an XRPC response.
   */
  timeoutMs?: number;
  /** Caller cancellation, composed with the timeout — whichever fires first. */
  signal?: AbortSignal;
}

function combinedSignal(opts: HttpOptions): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
}

/** Raw response, for callers that stream, handle redirects themselves, or read non-JSON. */
export async function request(url: string, opts: HttpOptions = {}): Promise<Response> {
  return fetch(url, {
    method: opts.method ?? 'GET',
    headers: { 'user-agent': HTTP_USER_AGENT, ...opts.headers },
    body: opts.body,
    ...(opts.redirect ? { redirect: opts.redirect } : {}),
    signal: combinedSignal(opts),
  });
}

/**
 * JSON response, or `null` when upstream answered with an empty body.
 *
 * Non-2xx throws `HttpError`, which carries the status (and the rate-limit hint
 * when the provider sent one) so `withRetry` can retry 429/5xx and a breaker can
 * count the failure.
 */
export async function requestJson<T>(url: string, opts: HttpOptions = {}): Promise<T | null> {
  const res = await request(url, {
    ...opts,
    headers: { accept: 'application/json', ...opts.headers },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* body unreadable; the status is the useful part */
    }
    throw new HttpError(
      res.status,
      `${opts.method ?? 'GET'} ${url.slice(0, 200)} -> ${res.status}: ${detail}`,
      parseRetryAfter(res.headers),
    );
  }
  const text = await res.text();
  if (text.trim() === '') return null;
  return JSON.parse(text) as T;
}

/**
 * The wait a provider asked for: ISBNdb sends `ratelimit: "rate"; r=…; t=…`,
 * everyone else the standard seconds form.
 */
export function parseRetryAfter(headers: Headers): number | undefined {
  const ratelimit = headers.get('ratelimit');
  if (ratelimit) {
    const m = /^"(?:rate|daily)";\s*r=(\d+);\s*t=(\d+)/.exec(ratelimit);
    if (m && m[2] !== undefined) return Number(m[2]) * 1000;
  }
  const header = headers.get('retry-after');
  if (!header) return undefined;
  const secs = Number(header);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}


