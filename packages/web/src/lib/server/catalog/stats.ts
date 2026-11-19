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
 * Estimates from `pg_class.reltuples`, not `count(*)`.
 *
 * Four exact counts were measured at 434 ms warm on production and touched
 * 88 759 buffers (~694 MB) per call: that is more than the host's entire
 * `shared_buffers` (488 MB), so every refresh evicted the working set and the
 * next feed read, publisher insert or identifier count came from disk. The
 * docs page does not need last-second exactness; `ANALYZE` (autovacuum and
 * every deploy) keeps the estimates within a few percent, and this query reads
 * a handful of catalog pages instead of the catalog itself.
 *
 * The 60s TTL and the boot warm-up stay: they cost nothing now and keep the
 * page stable when the estimates refresh.
 */
const STATS_TTL_MS = 60_000;

async function countCatalog(): Promise<CatalogStats> {
  const { rows } = await catalogPool().query<StatsRow>(`
    SELECT
      COALESCE(max(c.reltuples) FILTER (WHERE c.relname = 'books'), 0)::bigint AS editions,
      COALESCE(max(c.reltuples) FILTER (WHERE c.relname = 'contributors'), 0)::bigint AS contributors,
      COALESCE(max(c.reltuples) FILTER (WHERE c.relname = 'publishers'), 0)::bigint AS publishers,
      COALESCE(max(c.reltuples) FILTER (WHERE c.relname = 'edition_identifiers'), 0)::bigint AS identifiers
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('books', 'contributors', 'publishers', 'edition_identifiers')
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
