import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db';
import { googleBooksCache } from '../db/schema';
import { googleBooksCacheTotal } from '../metrics';

/**
 * Postgres-backed cache for Google Books responses.
 *
 * Why Postgres and not a Map: the quota is charged per request against a single
 * API key that every process shares, and the expensive callers are spread across
 * the web server (shelf hydration, search) and the workers (ISBN backfills). A
 * process-local cache would let each of them spend the same quota on the same
 * query, and would lose everything on restart or deploy.
 *
 * The key is the request URL with the transport-only parts removed, so a cached
 * response is reused regardless of which process asks and regardless of the key
 * value in use.
 */

/**
 * Both hits and misses live for a day: the quota is consumed by the request, not
 * by the answer, so remembering "no such volume" saves exactly as much as
 * remembering a hit. A day is short enough that a removed or newly added volume
 * reappears without manual intervention.
 */
export const GB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Expired rows are swept at most this often per process, `PRUNE_BATCH` at a time. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_BATCH = 500;
let lastPruneAt = 0;

export interface GbCacheEntry {
  /** sha256 over the normalized URL. */
  key: string;
  /** The URL with the API key and non-canonical parameter order removed. */
  url: string;
}

/**
 * Derive the cache identity of a Google Books request URL.
 *
 * Two normalizations, both required for the cache to actually hit:
 *   - the `key` parameter is dropped. It is a credential, not part of the
 *     question, it must never be written to the database, and rotating keys or
 *     running keyless must not invalidate answers that do not depend on it.
 *   - remaining parameters are sorted, so that an equivalent query built in a
 *     different order is the same entry rather than a second quota charge.
 */
export function gbCacheEntry(url: string): GbCacheEntry {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => name !== 'key')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const normalized = `${parsed.origin}${parsed.pathname}?${new URLSearchParams(params).toString()}`;
  const key = createHash('sha256').update(normalized).digest('hex');
  return { key, url: normalized };
}

/**
 * `found: false` means no live entry — the caller must ask upstream. When
 * `found` is true, `body === null` is a remembered negative: upstream has no
 * such volume, and the caller must treat it exactly like a fresh 404.
 */
export interface GbCacheLookup<T> {
  found: boolean;
  body: T | null;
}

export async function gbCacheGet<T>(key: string, log: Logger): Promise<GbCacheLookup<T>> {
  try {
    const rows = await db
      .select({ body: googleBooksCache.body })
      .from(googleBooksCache)
      .where(and(eq(googleBooksCache.key, key), gt(googleBooksCache.expiresAt, new Date())))
      .limit(1);
    const row = rows[0];
    if (!row) return { found: false, body: null };
    return { found: true, body: row.body as T | null };
  } catch (err) {
    // A cache failure must never fail the request: fall through to upstream,
    // which is exactly the pre-cache behavior.
    googleBooksCacheTotal.inc({ result: 'error' });
    log.warn({ stage: 'google-books-cache', err }, 'cache read failed; falling through to upstream');
    return { found: false, body: null };
  }
}

/** Store a response. `body === null` records a negative (no such volume). */
export async function gbCachePut(
  entry: GbCacheEntry,
  body: unknown | null,
  log: Logger,
): Promise<void> {
  const now = Date.now();
  const fetchedAt = new Date(now);
  const expiresAt = new Date(now + GB_CACHE_TTL_MS);
  try {
    await db
      .insert(googleBooksCache)
      .values({ key: entry.key, url: entry.url, body: body ?? null, fetchedAt, expiresAt })
      .onConflictDoUpdate({
        target: googleBooksCache.key,
        set: { url: entry.url, body: body ?? null, fetchedAt, expiresAt },
      });
    googleBooksCacheTotal.inc({ result: 'store' });
  } catch (err) {
    googleBooksCacheTotal.inc({ result: 'error' });
    log.warn({ stage: 'google-books-cache', err }, 'cache write failed; response served uncached');
  }
  await pruneExpired(log);
}

/**
 * Bounded sweep of expired rows, rate-limited per process.
 *
 * The table has no other reaper and would otherwise grow with every distinct
 * query ever made, so the write path pays for its own garbage collection. The
 * subquery limit keeps any single delete small enough not to hold locks long.
 */
async function pruneExpired(log: Logger): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    await db.execute(
      sql`delete from google_books_cache where key in (
        select key from google_books_cache where expires_at < now() limit ${PRUNE_BATCH}
      )`,
    );
  } catch (err) {
    log.warn({ stage: 'google-books-cache', err }, 'cache prune failed');
  }
}
