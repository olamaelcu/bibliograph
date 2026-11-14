/**
 * `community.lexicon.media.book.defs#editionView` building, shared by the
 * edition procedures and the entity queries.
 *
 * The module takes a pg query surface instead of reaching for `catalogPool()`
 * itself, so it has no SvelteKit/env import and node tests can drive it with a
 * mock. `editions.ts` re-exports these types for the route and jobs modules.
 */

import type { Pool } from 'pg';
import { normalizeContributorRole } from '../../contributor-roles.ts';

export type EditionQueryable = Pick<Pool, 'query'>;

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

export type EditionView = {
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

export type EditionResults = { items: EditionView[]; hasMore: boolean; total?: number };

/** A global token for "this value is the atproto URI of the edition". */
export const AT_URI_ISSUER = 'atproto';

export type EditionRow = {
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

export const EDITION_COLUMNS = `
  e.uri, e.title, e.subtitle, e.duration_seconds, e.chapters, e.series,
  e.book_edition, e.cover_url, e.created_at, s.language AS shape_language,
  s.published_date AS shape_published_date, s.format AS shape_format,
  s.pages AS shape_pages, s.description AS shape_description`;

/** The shape claim union; every `EDITION_COLUMNS` query needs it. */
export const EDITION_SHAPE_JOIN =
  'LEFT JOIN edition_identifier_shape s ON s.edition_uri = e.uri';

function atUriIdentifier(uri: string): Identifier {
  return { issuer: AT_URI_ISSUER, value: uri };
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

export function editionView(
  row: EditionRow,
  identifiers: IdentifierRow[],
  contributors: ContributorRow[],
  publisher: PublisherRow | undefined
): EditionView {
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

  const view: EditionView = {
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

  const coverUrl = optional(row.cover_url);
  if (coverUrl) view.coverUrl = coverUrl;
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

export async function hydrate(pool: EditionQueryable, rows: EditionRow[]): Promise<EditionView[]> {
  if (rows.length === 0) return [];
  const uris = rows.map((row) => row.uri);

  const [identifierResult, contributorResult, publisherResult] = await Promise.all([
    pool.query<IdentifierRow>(
      `SELECT edition_uri, issuer, value FROM edition_identifiers
       WHERE edition_uri = ANY($1) ORDER BY issuer, value`,
      [uris]
    ),
    pool.query<ContributorRow>(
      `SELECT ec.edition_uri, c.name, ec.role, c.identifiers,
              COALESCE(ec.ref, c.at_uri) AS ref
       FROM edition_contributors ec
       JOIN contributors c ON c.id = ec.contributor_id
       WHERE ec.edition_uri = ANY($1)
       ORDER BY ec.edition_uri, ec.position`,
      [uris]
    ),
    pool.query<PublisherRow>(
      `SELECT ps.edition_uri, p.name, p.identifiers, p.at_uri AS ref
       FROM edition_publishers_shape ps
       CROSS JOIN LATERAL unnest(ps.publisher_ids) WITH ORDINALITY AS ord(id, idx)
       JOIN publishers p ON p.id = ord.id
       WHERE ps.edition_uri = ANY($1)
       ORDER BY ps.edition_uri, ord.idx`,
      [uris]
    )
  ]);

  const identifiers = new Map<string, IdentifierRow[]>();
  for (const row of identifierResult.rows) {
    identifiers.set(row.edition_uri, [...(identifiers.get(row.edition_uri) ?? []), row]);
  }
  const contributors = new Map<string, ContributorRow[]>();
  for (const row of contributorResult.rows) {
    contributors.set(row.edition_uri, [...(contributors.get(row.edition_uri) ?? []), row]);
  }
  const publishers = new Map<string, PublisherRow>();
  for (const row of publisherResult.rows) {
    if (!publishers.has(row.edition_uri)) publishers.set(row.edition_uri, row);
  }

  return rows.map((row) =>
    editionView(
      row,
      identifiers.get(row.uri) ?? [],
      contributors.get(row.uri) ?? [],
      publishers.get(row.uri)
    )
  );
}
