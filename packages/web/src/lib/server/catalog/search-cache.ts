/**
 * A short-TTL, in-process cache for `searchEditions` pages.
 *
 * Search is the one catalog read whose cost is set by the request, and the
 * same requests arrive in bursts: a reader pages through one result set, and
 * several clients ask for the same popular title at once. A ten-second answer
 * for exactly the same body is not stale in any way a caller can notice, while
 * it takes a multiple of the load off a two-vCPU host.
 *
 * Scope, deliberately:
 *
 * - One cache per process. A multi-process deployment holds several copies,
 *   and a fresh process starts empty.
 * - An entry is served for at most `SEARCH_CACHE_TTL_MS` after it was stored
 *   (reading it does not extend that), so a catalogue write shows through in
 *   seconds at worst.
 * - At most `SEARCH_CACHE_CAPACITY` entries are kept; the least recently used
 *   one is evicted first. A page is a few KiB, so the bound keeps memory flat.
 *
 * The module has no imports beyond types, so a node test can drive it without
 * SvelteKit's virtual modules.
 */

import type { BookResults, Identifier } from './book-view.ts';

/** Distinct searches remembered per process. */
export const SEARCH_CACHE_CAPACITY = 200;

/** How long a stored page is served before the database answers again. */
export const SEARCH_CACHE_TTL_MS = 10_000;

/** The inputs a search cache key is built from: exactly what changes a page. */
export type SearchCacheInput = {
  q?: string;
  title?: string;
  author?: string;
  language?: string;
  identifiers: readonly Identifier[];
  offset: number;
  limit: number;
  sort?: string;
  order?: string;
};

export type SearchCache<T = BookResults> = {
  /** The live entry for `key`, or `undefined` when absent or expired. */
  get(key: string): T | undefined;
  set(key: string, value: T): void;
};

/**
 * A deterministic key over every input that changes the result.
 *
 * The tuple is serialised in a fixed order — the `identifiers` array in the
 * order it was given, which the contract treats as significant — so two
 * identical requests produce one key and any difference in a field produces
 * another. `coversBaseUrl` participates because it decides whether a cover URL
 * points at this deployment's `/api/covers` or at the provider.
 */
export function keyFor(input: SearchCacheInput, coversBaseUrl: string): string {
  return JSON.stringify([
    input.q ?? null,
    input.title ?? null,
    input.author ?? null,
    input.language ?? null,
    input.identifiers.map((identifier) => [identifier.issuer, identifier.value]),
    input.sort ?? null,
    input.order ?? null,
    input.limit,
    input.offset,
    coversBaseUrl
  ]);
}

/** An LRU bounded by `capacity` and aged out by `ttlMs`; the clock is injectable for tests. */
export function createSearchCache<T = BookResults>(options: {
  capacity?: number;
  ttlMs?: number;
  now?: () => number;
} = {}): SearchCache<T> {
  const capacity = Math.max(1, Math.floor(options.capacity ?? SEARCH_CACHE_CAPACITY));
  const ttlMs = options.ttlMs ?? SEARCH_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  // Map iterates in insertion order, so re-inserting on read makes the first
  // key the least recently used one.
  const entries = new Map<string, { value: T; storedAt: number }>();

  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (now() - entry.storedAt >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    set(key: string, value: T): void {
      entries.delete(key);
      entries.set(key, { value, storedAt: now() });
      while (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    }
  };
}

/**
 * The process-wide `searchEditions` cache.
 *
 * A SvelteKit dev reload replaces this module and with it the cache; the TTL is
 * ten seconds, so that costs one extra query per distinct search at worst.
 */
export const searchCache = createSearchCache<BookResults>();

/**
 * Read through `cache`: a live entry is returned without calling `load`, and a
 * miss stores only what `load` resolves with.
 *
 * A thrown `load` propagates and is never stored, so a failed query is retried
 * on the next request instead of re-answering its error for the TTL. Cache
 * faults are swallowed in both directions: the cache is an optimisation and
 * the database answer stands on its own without it.
 */
export async function remember<T>(
  cache: SearchCache<T>,
  key: string,
  load: () => Promise<T>
): Promise<{ value: T; hit: boolean }> {
  try {
    const cached = cache.get(key);
    if (cached !== undefined) return { value: cached, hit: true };
  } catch {
    // A cache read that throws is a miss.
  }

  const value = await load();
  try {
    cache.set(key, value);
  } catch {
    // A cache write that throws only costs the next caller a query.
  }
  return { value, hit: false };
}
