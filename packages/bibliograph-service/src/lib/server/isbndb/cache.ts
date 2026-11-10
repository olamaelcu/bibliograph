import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db';
import { isbndbCache } from '../db/schema';
import { isbndbCacheTotal } from '../metrics';

/**
 * Postgres-backed cache for ISBNdb responses, mirroring `gb/cache.ts`.
 *
 * Google Books has had one since the search path started fanning out per
 * edition; ISBNdb did not, so every search that found editions paid for a fresh
 * `POST /books` (measured 110-160 ms from this host, plus quota) even for the
 * same ISBN set a second earlier. Postgres rather than a Map for the same
 * reason as the Google Books cache: the web process, the worker and the
 * backfill scripts all spend the same key, and a process-local cache would let
 * each of them pay for the same answer and lose it on restart.
 */

/** Both hits and misses live for a day: the quota is spent by the request, not the answer. */
export const ISBNDB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_BATCH = 500;
let lastPruneAt = 0;

export interface IsbndbCacheEntry {
  /** sha256 over method + normalized URL + request body. */
  key: string;
  /** What the entry asked for, for audit. Never carries the API key (it is a header). */
  request: string;
}

/**
 * Derive the cache identity of an ISBNdb request.
 *
 * Method and body are part of the key because the same path means different
 * questions: `POST /books` asks about a set of ISBNs carried in the body, while
 * `GET /book/{isbn}` asks about one. Parameters are sorted so an equivalent URL
 * is one entry.
 */
export function isbndbCacheEntry(url: string, method = 'GET', body = ''): IsbndbCacheEntry {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
  const request = `${method.toUpperCase()} ${parsed.origin}${parsed.pathname}${query}`;
  const bodyHash = body ? createHash('sha256').update(body).digest('hex') : '';
  const key = createHash('sha256').update(bodyHash ? `${request}\n${bodyHash}` : request).digest('hex');
  return { key, request: bodyHash ? `${request} body:${bodyHash.slice(0, 16)}` : request };
}

/**
 * `found: false` means no live entry — the caller must ask upstream. When
 * `found` is true, `body === null` is a remembered negative: upstream has no
 * such ISBN, and the caller must treat it exactly like a fresh 404.
 */
export interface IsbndbCacheLookup<T> {
  found: boolean;
  body: T | null;
}

export async function isbndbCacheGet<T>(key: string, log: Logger): Promise<IsbndbCacheLookup<T>> {
  try {
    const rows = await db
      .select({ body: isbndbCache.body })
      .from(isbndbCache)
      .where(and(eq(isbndbCache.key, key), gt(isbndbCache.expiresAt, new Date())))
      .limit(1);
    const row = rows[0];
    if (!row) return { found: false, body: null };
    return { found: true, body: row.body as T | null };
  } catch (err) {
    // A cache failure must never fail the request: fall through to upstream.
    isbndbCacheTotal.inc({ result: 'error' });
    log.warn({ stage: 'isbndb-cache', err }, 'cache read failed; falling through to upstream');
    return { found: false, body: null };
  }
}

/** Store a response. `body === null` records a negative (no such ISBN). */
export async function isbndbCachePut(
  entry: IsbndbCacheEntry,
  body: unknown | null,
  log: Logger,
): Promise<void> {
  const now = Date.now();
  const fetchedAt = new Date(now);
  const expiresAt = new Date(now + ISBNDB_CACHE_TTL_MS);
  try {
    await db
      .insert(isbndbCache)
      .values({ key: entry.key, request: entry.request, body: body ?? null, fetchedAt, expiresAt })
      .onConflictDoUpdate({
        target: isbndbCache.key,
        set: { request: entry.request, body: body ?? null, fetchedAt, expiresAt },
      });
    isbndbCacheTotal.inc({ result: 'store' });
  } catch (err) {
    isbndbCacheTotal.inc({ result: 'error' });
    log.warn({ stage: 'isbndb-cache', err }, 'cache write failed; response served uncached');
  }
  await pruneExpired(log);
}

/** Bounded sweep of expired rows, rate-limited per process (same shape as the GB cache). */
async function pruneExpired(log: Logger): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    await db.execute(
      sql`delete from isbndb_cache where key in (
        select key from isbndb_cache where expires_at < now() limit ${PRUNE_BATCH}
      )`,
    );
  } catch (err) {
    log.warn({ stage: 'isbndb-cache', err }, 'cache prune failed');
  }
}
