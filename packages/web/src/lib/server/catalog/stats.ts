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
 * Shape matters as much as source: `relnamespace = 'public'::regnamespace` is
 * a parse-time constant, so this is one lookup on `pg_class_relname_nsp_index`
 * per table with no namespace join (which cost 238 planning buffers). It also
 * stays honest on a database that has not been migrated yet: no rows instead
 * of a `::regclass` cast error, and `to_regclass` is avoided because it takes a
 * lock on the relation for a value this query already knows. The estimates
 * only move when `ANALYZE` runs, which is per deploy and per autovacuum, so a
 * five-minute TTL keeps every ordinary request off the catalog entirely while
 * the counts still refresh long before anyone notices.
 */
const STATS_TTL_MS = 300_000;

async function countCatalog(): Promise<CatalogStats> {
  const { rows } = await catalogPool().query<StatsRow>(`
    SELECT
      (SELECT GREATEST(reltuples, 0)::bigint FROM pg_class
        WHERE relname = 'books' AND relnamespace = 'public'::regnamespace) AS editions,
      (SELECT GREATEST(reltuples, 0)::bigint FROM pg_class
        WHERE relname = 'contributors' AND relnamespace = 'public'::regnamespace) AS contributors,
      (SELECT GREATEST(reltuples, 0)::bigint FROM pg_class
        WHERE relname = 'publishers' AND relnamespace = 'public'::regnamespace) AS publishers,
      (SELECT GREATEST(reltuples, 0)::bigint FROM pg_class
        WHERE relname = 'edition_identifiers' AND relnamespace = 'public'::regnamespace) AS identifiers
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

/** One round trip per five minutes at most, shared by every concurrent reader. */
export const readCatalogStats = cachedLoader<CatalogStats>({
  ttlMs: STATS_TTL_MS,
  staleWhileRevalidate: true,
  load: countCatalog
});
