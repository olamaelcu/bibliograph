/**
 * Client for the external search index (`bibliograph-search`) and the selection
 * of which search backend answers a request.
 *
 * The index is a loopback service next to the edge; this module is the only
 * place that knows its wire shape. A failure is never fatal: the caller falls
 * back to the Postgres path, which stays the source of truth.
 */

export type SearchBackend = 'postgres' | 'shadow' | 'tantivy';

/** Unknown or unset means Postgres: the conservative backend. */
export function parseSearchBackend(value: string | undefined): SearchBackend {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'shadow' || normalized === 'tantivy' ? normalized : 'postgres';
}

export interface EngineConfig {
  /** Loopback base URL, or undefined when the index is not configured. */
  url?: string;
  timeoutMs: number;
}

/** Unset `SEARCH_URL` keeps the index off, whatever the backend says. */
export function engineConfig(source: Record<string, string | undefined>): EngineConfig {
  const url = (source.SEARCH_URL ?? '').trim().replace(/\/+$/, '');
  const parsed = Number.parseInt(source.SEARCH_ENGINE_TIMEOUT_MS ?? '', 10);
  return {
    url: url === '' ? undefined : url,
    timeoutMs: Number.isFinite(parsed) && parsed > 0 ? parsed : 400
  };
}

export interface EngineQuery {
  q?: string;
  title?: string;
  author?: string;
  language?: string;
  sort?: string;
  order?: string;
  offset: number;
  limit: number;
}

export interface EngineResult {
  uris: string[];
  hasMore: boolean;
  total: number;
}

/**
 * Ask the index for one page of edition uris. Throws on any deviation from the
 * contract (timeout, non-2xx, malformed body) so the caller can fall back.
 */
export async function searchEngineUris(
  query: EngineQuery,
  options: { url: string; timeoutMs: number; fetchImpl?: typeof fetch }
): Promise<EngineResult> {
  const { url, timeoutMs, fetchImpl = fetch } = options;
  const response = await fetchImpl(`${url}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`search engine: HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('search engine: response is not an object');
  }
  const { uris, hasMore, total } = body as Record<string, unknown>;
  if (!Array.isArray(uris) || !uris.every((uri) => typeof uri === 'string')) {
    throw new Error('search engine: uris is not an array of strings');
  }
  return {
    uris,
    hasMore: hasMore === true,
    total: typeof total === 'number' && Number.isFinite(total) ? total : 0
  };
}

/**
 * Ask the index for prefix completions. Same failure contract as
 * `searchEngineUris`: anything off-spec throws so the caller can fall back.
 */
export async function typeaheadEngineUris(
  query: { q: string; limit: number },
  options: { url: string; timeoutMs: number; fetchImpl?: typeof fetch }
): Promise<string[]> {
  const { url, timeoutMs, fetchImpl = fetch } = options;
  const response = await fetchImpl(`${url}/typeahead`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`search engine: HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('search engine: response is not an object');
  }
  const { uris } = body as Record<string, unknown>;
  if (!Array.isArray(uris) || !uris.every((uri) => typeof uri === 'string')) {
    throw new Error('search engine: uris is not an array of strings');
  }
  return uris;
}

/**
 * Fraction of the two pages they agree on, over their top `k`. Uses the larger
 * of the two page lengths as the denominator so a short page cannot score 1 by
 * being a subset.
 */
export function topOverlap(left: readonly string[], right: readonly string[], k = 25): number {
  const size = Math.min(k, Math.max(left.length, right.length));
  if (size === 0) return 1;
  const wanted = new Set(left.slice(0, k));
  let hits = 0;
  for (const uri of right.slice(0, k)) {
    if (wanted.has(uri)) hits += 1;
  }
  return hits / size;
}
