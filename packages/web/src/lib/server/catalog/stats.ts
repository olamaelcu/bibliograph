import { catalogPool } from './db';
import { cachedLoader } from '../cached-loader';

/** Live row counts for the catalog tables the docs page advertises. */
export type CatalogStats = {
  editions: number;
  contributors: number;
  publishers: number;
  identifiers: number;
};

type StatsRow = {
  editions: string;
  contributors: string;
  publishers: string;
  identifiers: string;
};

/**
 * Four `count(*)` over the whole catalog are exact but not cheap: measured
 * 565 ms warm and 1.5 s cold on the production catalog (146k editions, 357k
 * identifiers), which was the entire latency of `GET /` and `/api/stats`.
 * Nothing on that page needs the count of this second, so the result is reused
 * for a minute and an expired one is served while it refreshes behind the
 * caller; a failure is not cached.
 *
 * `hooks.server.ts` warms it at boot. That matters because `/` traffic is
 * sparse: without the warm-up the first request after a restart pays the four
 * counts, and one slow sample among a handful owns the route's p95.
 */
const STATS_TTL_MS = 60_000;

async function countCatalog(): Promise<CatalogStats> {
  const { rows } = await catalogPool().query<StatsRow>(`
    SELECT
      (SELECT count(*) FROM editions) AS editions,
      (SELECT count(*) FROM contributors) AS contributors,
      (SELECT count(*) FROM publishers) AS publishers,
      (SELECT count(*) FROM edition_identifiers) AS identifiers
  `);

  const row = rows[0];
  if (!row) throw new Error('catalog stats query returned no rows');

  // `count(*)` is bigint; node-postgres returns it as a string, so coerce once.
  return {
    editions: Number(row.editions),
    contributors: Number(row.contributors),
    publishers: Number(row.publishers),
    identifiers: Number(row.identifiers)
  };
}

/** One round trip per minute at most, shared by every concurrent reader. */
export const readCatalogStats = cachedLoader<CatalogStats>({
  ttlMs: STATS_TTL_MS,
  staleWhileRevalidate: true,
  load: countCatalog
});
