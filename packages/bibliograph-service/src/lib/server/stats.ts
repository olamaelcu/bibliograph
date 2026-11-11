import { count } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db as defaultDb } from './db';
import { editions, contributors, publishers } from './db/schema';

export type DbExecutor = typeof defaultDb;

export type Counts = {
  editions: number;
  contributors: number;
  publishers: number;
  generatedAt: string;
};

async function countTable(db: DbExecutor, table: PgTable): Promise<number> {
  const [row] = await db.select({ c: count() }).from(table);
  return Number(row?.c ?? 0);
}

export async function fetchCounts(db: DbExecutor = defaultDb): Promise<Counts> {
  const [editionsCount, contributorsCount, publishersCount] = await Promise.all([
    countTable(db, editions),
    countTable(db, contributors),
    countTable(db, publishers),
  ]);
  return {
    editions: editionsCount,
    contributors: contributorsCount,
    publishers: publishersCount,
    generatedAt: new Date().toISOString(),
  };
}
/**
 * How long a count tuple stands.
 *
 * `/stats` polls `/stats/counts` every five seconds from every open tab, and each
 * poll ran four `count(*)` scans: 42.7 ms on `editions` alone against the local
 * catalogue, so ten idle tabs meant millions of rows scanned per second for a
 * number that moves at human pace.
 */
const COUNTS_TTL_MS = 30_000;

let cachedCounts: { at: number; counts: Counts } | undefined;

/** Cached counts for the page load and the polling endpoint. */
export async function fetchCountsCached(db: DbExecutor = defaultDb): Promise<Counts> {
  const now = Date.now();
  if (cachedCounts && now - cachedCounts.at < COUNTS_TTL_MS) return cachedCounts.counts;
  const counts = await fetchCounts(db);
  cachedCounts = { at: now, counts };
  return counts;
}

/** Test hook: forget the memoized tuple. */
export function resetCountsCacheForTesting(): void {
  cachedCounts = undefined;
}