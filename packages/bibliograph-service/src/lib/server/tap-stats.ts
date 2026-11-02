/**
 * TAP's own view of its backlog.
 *
 * `/channel` has no cursor parameter — the handler streams the outbox and the
 * only resume mechanism is an unacknowledged event staying in that outbox — so
 * the honest measure of "am I behind" is TAP's outbox, not our job table.
 * `outbox_buffer` is that number; `resync_buffer` is the crawler's.
 *
 * Cached for a second: this is read from the consumer's event loop, and TAP is
 * a local HTTP service that should not be hit per event.
 */

export interface TapStats {
  outboxBuffer: number;
  resyncBuffer: number;
}

const CACHE_TTL_MS = 1000;
const REQUEST_TIMEOUT_MS = 2_000;

let cached: { value: TapStats; fetchedAt: number } | null = null;

function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = path;
  url.search = '';
  return url.toString();
}

async function readNumber(
  baseUrl: string,
  path: string,
  key: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<number | null> {
  const response = await fetchImpl(endpoint(baseUrl, path), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as Record<string, unknown>;
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read TAP's backlog. `null` when the server cannot answer (older build,
 * unreachable): the caller keeps its own fallback rather than treating an
 * unknown backlog as zero.
 */
export async function fetchTapStats(
  baseUrl: string,
  options: { fetch?: typeof globalThis.fetch; now?: number } = {},
): Promise<TapStats | null> {
  const now = options.now ?? Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const [outboxBuffer, resyncBuffer] = await Promise.all([
      readNumber(baseUrl, '/stats/outbox-buffer', 'outbox_buffer', fetchImpl),
      readNumber(baseUrl, '/stats/resync-buffer', 'resync_buffer', fetchImpl),
    ]);
    if (outboxBuffer === null) return null;
    const value: TapStats = { outboxBuffer, resyncBuffer: resyncBuffer ?? 0 };
    cached = { value, fetchedAt: now };
    return value;
  } catch {
    return null;
  }
}

/** Test hook: forget the last reading. */
export function resetTapStatsCache(): void {
  cached = null;
}
