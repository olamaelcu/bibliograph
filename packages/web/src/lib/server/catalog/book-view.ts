/**
 * `community.lexicon.media.book.defs#editionView` building, shared by the
 * edition procedures and the entity queries.
 *
 * The module takes a pg query surface instead of reaching for `catalogPool()`
 * itself, so it has no SvelteKit/env import and node tests can drive it with a
 * mock. `books.ts` re-exports these types for the route and jobs modules.
 */

import type { Pool } from 'pg';
import { normalizeContributorRole } from '../../contributor-roles.ts';

export type BookQueryable = Pick<Pool, 'query'>;

export type Identifier = {
  issuer: string;
  value: string;
  url?: string;
};

export type ContributorView = {
  displayName: string;
  nameInverted?: string;
  role?: string;
  identifiers?: Identifier[];
  ref?: string;
};

export type PublisherView = { name: string; identifiers?: Identifier[]; ref?: string };

export type SeriesView = { name: string; position?: string; display?: string };

export type BookView = {
  title: string;
  identifiers: Identifier[];
  contributors: ContributorView[];
  createdAt: string;
  coverUrl?: string;
  subtitle?: string;
  language?: string;
  publishedDate?: string;
  publisher?: PublisherView;
  format?: string;
  pages?: number;
  durationSeconds?: number;
  chapters?: number;
  series?: SeriesView;
  bookEdition?: string;
  description?: string;
};

export type BookResults = { items: BookView[]; hasMore: boolean; total?: number };

/** A global token for "this value is the atproto URI of the edition". */
export const AT_URI_ISSUER = 'atproto';

export type BookRow = {
  uri: string;
  title: string;
  subtitle: string | null;
  shape_language: string | null;
  shape_published_date: string | null;
  shape_format: string | null;
  shape_pages: number | null;
  duration_seconds: number | null;
  chapters: number | null;
  series: SeriesView | null;
  book_edition: string | null;
  shape_description: string | null;
  cover_url: string | null;
  /** True when `cover_url`'s bytes are on disk and the edge can serve them. */
  cover_cached: boolean;
  created_at: Date;
};

export type IdentifierRow = { edition_uri: string; issuer: string; value: string };
export type ContributorRow = {
  edition_uri: string;
  name: string;
  role: string;
  identifiers: Identifier[] | null;
  ref: string | null;
};
export type PublisherRow = {
  edition_uri: string;
  name: string;
  identifiers: Identifier[] | null;
  ref: string | null;
};

export const BOOK_COLUMNS = `
  e.uri, e.title, e.subtitle, s.duration_seconds, e.chapters, e.series,
  e.book_edition, e.cover_url, e.created_at, s.language AS shape_language,
  s.published_date AS shape_published_date, s.format AS shape_format,
  s.pages AS shape_pages, s.description AS shape_description,
  (cf.edition_uri IS NOT NULL) AS cover_cached`;

/** The shape claim union; every `BOOK_COLUMNS` query needs it. */
export const BOOK_SHAPE_JOIN =
  'LEFT JOIN edition_identifier_shape s ON s.edition_uri = e.uri';

/**
 * The cover cache claim; every `BOOK_COLUMNS` query needs it. Paired on
 * `source_url` so a cache row for a previous provider URL does not count: the
 * edge would be serving bytes the edition no longer points at.
 */
export const BOOK_COVERS_JOIN =
  'LEFT JOIN edition_cover_files cf ON cf.edition_uri = e.uri AND cf.source_url = e.cover_url';

/**
 * The `/api/covers` URL for one edition, or `''` when no public origin is
 * configured (records and views then keep the provider URL). The path shape must
 * match `buildEditionRecord` in packages/worker/lib/edition-record.js and the
 * route at `src/routes/api/covers/[...atUri]`.
 */
export function coverFileUrl(base: string, editionUri: string): string {
  const origin = base.trim().replace(/\/+$/, '');
  if (origin === '') return '';
  return `${origin}/api/covers/${encodeURIComponent(editionUri)}`;
}

function atUriIdentifier(uri: string): Identifier {
  return { issuer: AT_URI_ISSUER, value: uri };
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

export function editionView(
  row: BookRow,
  identifiers: IdentifierRow[],
  contributors: ContributorRow[],
  publisher: PublisherRow | undefined,
  coversBaseUrl = ''
): BookView {
  // The edition view has no `uri` field, so the record URI travels as an
  // identifier: clients rebuild links such as /book/<did>/<rkey> from it.
  const seen = new Set<string>();
  const bag: Identifier[] = [];
  const stored: Identifier[] = identifiers.map((identifier) => ({
    issuer: identifier.issuer,
    value: identifier.value
  }));
  for (const identifier of [atUriIdentifier(row.uri), ...stored]) {
    const key = `${identifier.issuer}\u0000${identifier.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bag.push(identifier);
  }

  const view: BookView = {
    title: row.title,
    identifiers: bag,
    contributors: contributors
      .filter((contributor) => contributor.name !== '')
      .map((contributor) => ({
        displayName: contributor.name,
        role: normalizeContributorRole(contributor.role),
        ...(contributor.identifiers?.length ? { identifiers: contributor.identifiers } : {}),
        ...(contributor.ref ? { ref: contributor.ref } : {})
      })),
    createdAt: new Date(row.created_at).toISOString()
  };

  // A cached cover is served from this deployment's own edge (long-lived
  // caching, no hotlink); until then the provider URL is what a reader gets.
  const edgeCover = row.cover_cached === true ? coverFileUrl(coversBaseUrl, row.uri) : '';
  if (edgeCover !== '') {
    view.coverUrl = edgeCover;
  } else {
    const providerCover = optional(row.cover_url);
    if (providerCover) view.coverUrl = providerCover;
  }
  const subtitle = optional(row.subtitle);
  if (subtitle) view.subtitle = subtitle;
  const language = optional(row.shape_language);
  if (language) view.language = language;
  const publishedDate = optional(row.shape_published_date);
  if (publishedDate) view.publishedDate = publishedDate;
  const format = optional(row.shape_format);
  if (format) view.format = format;
  const pages = optional(row.shape_pages);
  if (pages !== undefined) view.pages = pages;
  const durationSeconds = optional(row.duration_seconds);
  if (durationSeconds !== undefined) view.durationSeconds = durationSeconds;
  const chapters = optional(row.chapters);
  if (chapters !== undefined) view.chapters = chapters;
  if (row.series && typeof row.series.name === 'string' && row.series.name !== '') {
    view.series = {
      name: row.series.name,
      ...(typeof row.series.position === 'string' ? { position: row.series.position } : {}),
      ...(typeof row.series.display === 'string' ? { display: row.series.display } : {})
    };
  }
  const bookEdition = optional(row.book_edition);
  if (bookEdition) view.bookEdition = bookEdition;
  const description = optional(row.shape_description);
  if (description) view.description = description;
  if (publisher) {
    view.publisher = {
      name: publisher.name,
      ...(publisher.identifiers?.length ? { identifiers: publisher.identifiers } : {}),
      ...(publisher.ref ? { ref: publisher.ref } : {})
    };
  }

  return view;
}

export async function hydrate(
  pool: BookQueryable,
  rows: BookRow[],
  coversBaseUrl = ''
): Promise<BookView[]> {
  if (rows.length === 0) return [];
  const uris = rows.map((row) => row.uri);

  // One round trip instead of three: the page held up to three pooled
  // connections at once, and under an IO stall the third could not even be
  // acquired (2 s connection timeout) while the first two waited on a 10 s
  // statement bound. The per-uri lookups are the same index probes, aggregated
  // server-side so nothing is lost to the round trip.
  const hydrated = await pool.query<{
    uri: string;
    identifiers: { issuer: string; value: string }[];
    contributors: {
      name: string;
      role: string;
      identifiers: Identifier[] | null;
      ref: string | null;
    }[];
    publisher: { name: string; identifiers: Identifier[] | null; ref: string | null } | null;
  }>(
    `SELECT e.uri,
            COALESCE((
              SELECT json_agg(json_build_object('issuer', i.issuer, 'value', i.value)
                              ORDER BY i.issuer, i.value)
                FROM edition_identifiers i
               WHERE i.edition_uri = e.uri
            ), '[]'::json) AS identifiers,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'name', c.name, 'role', ec.role,
                       'identifiers', c.identifiers,
                       'ref', COALESCE(ec.ref, c.at_uri)) ORDER BY ec.position)
                FROM edition_contributors ec
                JOIN contributors c ON c.id = ec.contributor_id
               WHERE ec.edition_uri = e.uri
            ), '[]'::json) AS contributors,
            (
              SELECT json_build_object('name', p.name,
                                       'identifiers', p.identifiers,
                                       'ref', p.at_uri)
                FROM edition_publishers_shape ps
                CROSS JOIN LATERAL unnest(ps.publisher_ids)
                     WITH ORDINALITY AS ord(id, idx)
                JOIN publishers p ON p.id = ord.id
               WHERE ps.edition_uri = e.uri
               ORDER BY ord.idx
               LIMIT 1
            ) AS publisher
       FROM books e
      WHERE e.uri = ANY($1)`,
    [uris]
  );

  const byUri = new Map(hydrated.rows.map((row) => [row.uri, row]));
  return rows.map((row) => {
    const found = byUri.get(row.uri);
    return editionView(
      row,
      (found?.identifiers ?? []).map((identifier) => ({ edition_uri: row.uri, ...identifier })),
      (found?.contributors ?? []).map((contributor) => ({ edition_uri: row.uri, ...contributor })),
      found?.publisher ? { edition_uri: row.uri, ...found.publisher } : undefined,
      coversBaseUrl
    );
  });
}
