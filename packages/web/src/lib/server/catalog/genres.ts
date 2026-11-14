/**
 * Genre reads for editions.
 *
 * Like `entities.ts`, this is the anonymous edge-served half of the feature: it
 * reads the deployment's own tables (never a provider, never a PDS), and the
 * pool is injected as the `query` half of a pg Pool so the SQL and the mapping
 * are unit-testable with a mock.
 *
 * The genre rows are curated before they get here — the worker maps provider
 * labels to one shared vocabulary — so a name in `genres` is always a genre a
 * browsing UI can group on.
 */

// The extension is explicit so node's test runner can load this module directly
// (the rest of the app resolves extensionless imports through Vite).
import { type EntityQueryable } from './entities.ts';

/** The collection the `uri` parameter must address. */
export const EDITION_COLLECTION = 'community.lexicon.media.book.edition';

export type GenreView = { name: string; source: string };

export type EditionGenres = { uri: string; genres: GenreView[] };

/**
 * The genres of one edition, ordered as the worker stored them (Goodreads
 * relevance order first, then the OpenLibrary subjects).
 *
 * `null` means "no such edition in the catalog", which the edge answers as
 * `RecordNotFound`; an edition with no genres yet is an empty `genres` array,
 * because the edition itself does exist.
 */
export async function getEditionGenres(
  pool: EntityQueryable,
  uri: string
): Promise<EditionGenres | null> {
  const [exists, rows] = await Promise.all([
    pool.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM editions WHERE uri = $1) AS present`,
      [uri]
    ),
    pool.query<{ name: string; source: string }>(
      `SELECT g.name, eg.source
         FROM edition_genres eg
         JOIN genres g ON g.id = eg.genre_id
        WHERE eg.edition_uri = $1
        ORDER BY eg.position, g.name`,
      [uri]
    )
  ]);

  if (exists.rows[0]?.present !== true) return null;
  return {
    uri,
    genres: rows.rows.map((row) => ({ name: row.name, source: row.source }))
  };
}
