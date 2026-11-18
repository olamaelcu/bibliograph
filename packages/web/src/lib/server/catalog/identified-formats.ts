/**
 * Per-identifier format claims for editions.
 *
 * Like `genres.ts`, this is the anonymous edge-served half of the feature: it
 * reads the deployment's own tables (never a provider, never a PDS), and the
 * pool is injected as the `query` half of a pg Pool so the SQL and the mapping
 * are unit-testable with a mock.
 *
 * The edition record cannot answer these questions. Its `format`, `pages` and
 * `duration_seconds` are each an independent rank union over the identifier
 * claims (`edition_identifier_shape`, 0007), so three separate winners can
 * describe a product no identifier claims: a print ISBN-13 with 320 pages and
 * an audio ASIN with a 9-hour duration publish as `format: "physical"`,
 * `pages: 320`, `duration_seconds: 32400` at once. A reading position needs the
 * medium and the extent of the *same* product, so this module exposes the
 * claims one identifier at a time and lets the caller pick.
 *
 * Claims are ordered by the catalog's own rank — `identifier_shape_rank(issuer)`
 * (isbn13 → isbn10 → asin → any other), then `issuer`, then `value` — so a
 * consumer takes the first claim whose medium matches and nothing re-sorts. The
 * rank is spelled as an inline `CASE` because the function only exists once the
 * 0007 migration has run and this read must not depend on that.
 */

// The extension is explicit so node's test runner can load this module directly
// (the rest of the app resolves extensionless imports through Vite).
import { type EntityQueryable } from './entities.ts';

/** The collection the `uri` parameter must address. */
export const EDITION_COLLECTION = 'community.lexicon.media.book.edition';

/** The scale an identifier's extent is measured in. */
export type ProgressUnit = 'page' | 'timestamp';

export type IdentifiedFormat = {
  issuer: string;
  value: string;
  format?: string;
  pages?: number;
  durationSeconds?: number;
  progressUnit?: ProgressUnit;
};

export type BookIdentifiedFormats = {
  uri: string;
  chapters?: number;
  identifiers: IdentifiedFormat[];
};

type Row = {
  chapters: number | null;
  issuer: string;
  value: string;
  format: string | null;
  pages: number | null;
  duration_seconds: number | null;
};

/**
 * The catalog's rank expression, inline so the read works whether or not the
 * migration defined `identifier_shape_rank`.
 */
const RANK = `CASE i.issuer
                WHEN 'isbn13' THEN 0
                WHEN 'isbn10' THEN 1
                WHEN 'asin' THEN 2
                ELSE 3
              END`;

/**
 * The format claims of one edition, one entry per identifier.
 *
 * `null` means "no such edition in the catalog", which the edge answers as
 * `RecordNotFound`. An identifier attached without a provider claim (an admin
 * edit, a hand merge) has no `edition_identifier_info` row and comes back with
 * `issuer` and `value` only — the identifier is still known, the medium is not.
 */
export async function getBookIdentifiedFormats(
  pool: EntityQueryable,
  uri: string
): Promise<BookIdentifiedFormats | null> {
  const [exists, rows] = await Promise.all([
    pool.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM books WHERE uri = $1) AS present`,
      [uri]
    ),
    pool.query<Row>(
      `SELECT e.chapters,
              i.issuer,
              i.value,
              info.format,
              info.pages,
              info.duration_seconds
         FROM books e
         JOIN edition_identifiers i ON i.edition_uri = e.uri
         LEFT JOIN edition_identifier_info info
                ON info.edition_uri = i.edition_uri
               AND info.issuer = i.issuer
               AND info.value = i.value
        WHERE e.uri = $1
        ORDER BY ${RANK}, i.issuer, i.value`,
      [uri]
    )
  ]);

  if (exists.rows[0]?.present !== true) return null;

  const chapters = rows.rows[0]?.chapters;
  return {
    uri,
    ...(chapters === null || chapters === undefined ? {} : { chapters }),
    identifiers: rows.rows.map(identifiedFormat)
  };
}

function identifiedFormat(row: Row): IdentifiedFormat {
  const trimmedFormat = row.format?.trim();
  const format = trimmedFormat === undefined || trimmedFormat === '' ? undefined : trimmedFormat;
  const pages = row.pages !== null && row.pages > 0 ? row.pages : undefined;
  const durationSeconds =
    row.duration_seconds !== null && row.duration_seconds > 0 ? row.duration_seconds : undefined;
  // The extent, not the reader's preference: a client reads the numbers next to
  // it, and an EPUB reader may still track `virtual_page` of its own.
  const progressUnit: ProgressUnit | undefined =
    durationSeconds === undefined ? (pages === undefined ? undefined : 'page') : 'timestamp';
  return {
    issuer: row.issuer,
    value: row.value,
    ...(format === undefined ? {} : { format }),
    ...(pages === undefined ? {} : { pages }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(progressUnit === undefined ? {} : { progressUnit })
  };
}
