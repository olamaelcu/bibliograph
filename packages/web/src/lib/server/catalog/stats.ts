import { catalogPool } from './db';

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
 * One round trip: scalar subselects keep the four counts in a single row, so
 * polling the stats endpoint does not multiply queries against the catalog.
 * `count(*)` is bigint; node-postgres returns it as a string, so coerce once.
 */
export async function readCatalogStats(): Promise<CatalogStats> {
  const { rows } = await catalogPool().query<StatsRow>(`
    SELECT
      (SELECT count(*) FROM editions) AS editions,
      (SELECT count(*) FROM contributors) AS contributors,
      (SELECT count(*) FROM publishers) AS publishers,
      (SELECT count(*) FROM edition_identifiers) AS identifiers
  `);

  const row = rows[0];
  if (!row) throw new Error('catalog stats query returned no rows');

  return {
    editions: Number(row.editions),
    contributors: Number(row.contributors),
    publishers: Number(row.publishers),
    identifiers: Number(row.identifiers)
  };
}
