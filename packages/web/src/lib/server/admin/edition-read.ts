/**
 * Admin edition rows: the full catalog shape (scalars, identifiers,
 * contributors and publishers) plus the outbox timestamp.
 *
 * This module has no SvelteKit or environment imports so node tests can drive
 * it with a scratch pool. `editions.ts` is the route-facing wrapper that picks
 * `catalogPool()`; the edition editor supplies its own transaction client.
 */

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AdminEdition, AdminSeries, Identifier } from '../../admin/types.ts';

export type Queryable = Pool | PoolClient;

export type EditionRow = {
  uri: string;
  rkey: string;
  title: string;
  subtitle: string | null;
  language: string | null;
  published_date: string | null;
  format: string | null;
  pages: number | null;
  duration_seconds: number | null;
  chapters: number | null;
  series: AdminSeries | null;
  book_edition: string | null;
  description: string | null;
  cover_url: string | null;
  created_at: Date;
  indexed_at: Date;
  outbox_updated_at: Date | null;
};

export type IdentifierRow = { edition_uri: string; issuer: string; value: string };
export type ContributorRow = {
  edition_uri: string;
  id: string;
  name: string;
  role: string;
  identifiers: Identifier[] | null;
  ref: string | null;
};
export type PublisherRow = {
  edition_uri: string;
  id: string;
  name: string;
  identifiers: Identifier[] | null;
};

export const EDITION_COLUMNS = `
  e.uri, e.rkey, e.title, e.subtitle, e.language, e.published_date, e.format,
  e.pages, e.duration_seconds, e.chapters, e.series, e.book_edition,
  e.description, e.cover_url, e.created_at, e.indexed_at,
  o.updated_at AS outbox_updated_at`;

function iso(value: Date): string {
  return new Date(value).toISOString();
}

/**
 * Content revision used by the editor as an optimistic concurrency token.
 *
 * Only values an edit can change participate, so a publish attempt that
 * rewrites `pds_outbox.updated_at` never looks like a concurrent edit. The
 * order of identifiers, contributors and publishers is significant.
 */
function revisionOf(record: AdminEdition): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: record.title,
        subtitle: record.subtitle,
        language: record.language,
        publishedDate: record.publishedDate,
        format: record.format,
        pages: record.pages,
        durationSeconds: record.durationSeconds,
        chapters: record.chapters,
        series: record.series,
        bookEdition: record.bookEdition,
        description: record.description,
        coverUrl: record.coverUrl,
        identifiers: record.identifiers,
        contributors: record.contributors.map((contributor) => ({
          id: contributor.id,
          role: contributor.role,
          ref: contributor.ref
        })),
        publishers: record.publishers.map((publisher) => publisher.id)
      })
    )
    .digest('hex');
}

export function editionRecord(
  row: EditionRow,
  identifiers: IdentifierRow[],
  contributors: ContributorRow[],
  publishers: PublisherRow[]
): AdminEdition {
  const record: AdminEdition = {
    uri: row.uri,
    rkey: row.rkey,
    title: row.title,
    subtitle: row.subtitle,
    language: row.language,
    publishedDate: row.published_date,
    format: row.format,
    pages: row.pages,
    durationSeconds: row.duration_seconds,
    chapters: row.chapters,
    series: row.series,
    bookEdition: row.book_edition,
    description: row.description,
    coverUrl: row.cover_url,
    createdAt: iso(row.created_at),
    indexedAt: iso(row.indexed_at),
    updatedAt: iso(row.outbox_updated_at ?? row.indexed_at),
    revision: '',
    identifiers: identifiers.map((identifier) => ({
      issuer: identifier.issuer,
      value: identifier.value
    })),
    contributors: contributors.map((contributor) => ({
      id: Number(contributor.id),
      name: contributor.name,
      role: contributor.role,
      identifiers: contributor.identifiers ?? [],
      ref: contributor.ref
    })),
    publishers: publishers.map((publisher) => ({
      id: Number(publisher.id),
      name: publisher.name,
      identifiers: publisher.identifiers ?? []
    }))
  };
  record.revision = revisionOf(record);
  return record;
}

export async function hydrateAdminEditions(
  client: Queryable,
  rows: EditionRow[]
): Promise<AdminEdition[]> {
  if (rows.length === 0) return [];
  const uris = rows.map((row) => row.uri);
  // Sequential: the editor calls this with a transaction client, and pg does
  // not support overlapping queries on one connection.
  const identifierResult = await client.query<IdentifierRow>(
    `SELECT edition_uri, issuer, value
       FROM edition_identifiers
      WHERE edition_uri = ANY($1::text[])
      ORDER BY edition_uri, issuer, value`,
    [uris]
  );
  const contributorResult = await client.query<ContributorRow>(
    `SELECT ec.edition_uri, c.id, c.name, ec.role, c.identifiers, ec.ref
       FROM edition_contributors ec
       JOIN contributors c ON c.id = ec.contributor_id
      WHERE ec.edition_uri = ANY($1::text[])
      ORDER BY ec.edition_uri, ec.position`,
    [uris]
  );
  const publisherResult = await client.query<PublisherRow>(
    `SELECT ep.edition_uri, p.id, p.name, p.identifiers
       FROM edition_publishers ep
       JOIN publishers p ON p.id = ep.publisher_id
      WHERE ep.edition_uri = ANY($1::text[])
      ORDER BY ep.edition_uri, ep.position`,
    [uris]
  );

  const identifiers = new Map<string, IdentifierRow[]>();
  for (const row of identifierResult.rows) {
    const list = identifiers.get(row.edition_uri) ?? [];
    list.push(row);
    identifiers.set(row.edition_uri, list);
  }
  const contributors = new Map<string, ContributorRow[]>();
  for (const row of contributorResult.rows) {
    const list = contributors.get(row.edition_uri) ?? [];
    list.push(row);
    contributors.set(row.edition_uri, list);
  }
  const publishers = new Map<string, PublisherRow[]>();
  for (const row of publisherResult.rows) {
    const list = publishers.get(row.edition_uri) ?? [];
    list.push(row);
    publishers.set(row.edition_uri, list);
  }

  return rows.map((row) =>
    editionRecord(
      row,
      identifiers.get(row.uri) ?? [],
      contributors.get(row.uri) ?? [],
      publishers.get(row.uri) ?? []
    )
  );
}

/** Typeahead over local editions by title, at-URI or identifier. */
export async function searchAdminEditionsFrom(
  client: Queryable,
  input: { q: string; limit?: number }
): Promise<AdminEdition[]> {
  const q = input.q.trim();
  if (q === '') return [];
  const limit = Math.min(Math.max(input.limit ?? 15, 1), 25);
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  const result = await client.query<EditionRow>(
    `SELECT ${EDITION_COLUMNS}
       FROM editions e
       LEFT JOIN pds_outbox o ON o.uri = e.uri
      WHERE e.title ILIKE $1 ESCAPE '\\'
         OR e.uri = $2
         OR EXISTS (
              SELECT 1 FROM edition_identifiers i
               WHERE i.edition_uri = e.uri
                 AND (
                   i.value ILIKE $1 ESCAPE '\\'
                   OR (i.issuer || ':' || i.value) ILIKE $1 ESCAPE '\\'
                   OR i.value = $2
                   OR (i.issuer || ':' || i.value) = $2
                 )
            )
      ORDER BY CASE
                 WHEN e.uri = $2 THEN 0
                 WHEN e.title ILIKE $1 ESCAPE '\\' THEN 1
                 WHEN EXISTS (
                   SELECT 1 FROM edition_identifiers i2
                    WHERE i2.edition_uri = e.uri
                      AND (i2.value = $2 OR (i2.issuer || ':' || i2.value) = $2)
                 ) THEN 2
                 ELSE 3
               END,
               e.indexed_at DESC,
               e.uri
      LIMIT $3`,
    [pattern, q, limit]
  );
  return hydrateAdminEditions(client, result.rows);
}

/**
 * Load specific editions, optionally locking them for a write. Child rows are
 * read after the edition lock so the caller sees one consistent snapshot.
 */
export async function loadAdminEditionsFrom(
  client: Queryable,
  uris: string[],
  options: { forUpdate?: boolean } = {}
): Promise<AdminEdition[]> {
  const unique = [...new Set(uris)];
  if (unique.length === 0) return [];
  const result = await client.query<EditionRow>(
    `SELECT ${EDITION_COLUMNS}
       FROM editions e
       LEFT JOIN pds_outbox o ON o.uri = e.uri
      WHERE e.uri = ANY($1::text[])
      ${options.forUpdate ? 'FOR UPDATE OF e' : ''}`,
    [unique]
  );
  const records = await hydrateAdminEditions(client, result.rows);
  const byUri = new Map(records.map((record) => [record.uri, record]));
  return uris
    .map((uri) => byUri.get(uri))
    .filter((record): record is AdminEdition => Boolean(record));
}
