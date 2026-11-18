/**
 * Catalog reads for contributor and publisher records.
 *
 * These are the anonymous, edge-served half of the entity feature: they read
 * the deployment's own tables (never a PDS) exactly like `resolveEditions`.
 * HappyView is not involved — its index holds activity records, and the entity
 * records are published by the catalog's own repo, so the catalog tables are the
 * only complete, zero-lag source.
 *
 * `pool` is injected (typed as the `query` half of a pg Pool) so the module has
 * no SvelteKit imports and the SQL/mapping can be unit-tested with a mock.
 */

import type { Pool } from 'pg';
// The extension is explicit so node's test runner can load this module directly
// (the rest of the app resolves extensionless imports through Vite).
import {
  BOOK_COLUMNS,
  BOOK_COVERS_JOIN,
  BOOK_SHAPE_JOIN,
  hydrate,
  type BookRow,
  type BookView as CatalogBookView
} from './book-view.ts';
import {
  editionLanguageClause,
  editionOrderBy,
  type BookSort,
  type BookSortOrder
} from './books.ts';
import { decodeOffsetCursor, encodeOffsetCursor, likePattern, likePrefix } from './sql.ts';

export const CONTRIBUTOR_COLLECTION = 'net.olamaelcu.livtet.biblio.contributor';
export const PUBLISHER_COLLECTION = 'net.olamaelcu.livtet.biblio.publisher';

export type EntityQueryable = Pick<Pool, 'query'>;

export type EntityIdentifier = { issuer: string; value: string; url?: string };

export type ContributorView = {
  uri: string;
  cid?: string;
  displayName: string;
  nameInverted?: string;
  description?: string;
  imageUrl?: string;
  identifiers?: EntityIdentifier[];
  born?: string;
  died?: string;
  createdAt: string;
};

export type PublisherView = {
  uri: string;
  cid?: string;
  name: string;
  description?: string;
  imageUrl?: string;
  identifiers?: EntityIdentifier[];
  started?: string;
  ended?: string;
  createdAt: string;
};

export type EntityResults<T> = {
  items: T[];
  hasMore: boolean;
  total?: number;
};

export type SearchResults<T> = {
  items: T[];
  cursor?: string;
};

/** A URI that is not an entity record URI. The edge answers this as 400. */
export class EntityUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityUriError';
  }
}

/** A blank search term. The edge answers this as `InvalidQuery`. */
export class EntityQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityQueryError';
  }
}

const AT_URI = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const RKEY = /^[A-Za-z0-9._~:-]{1,512}$/;

/**
 * Parse `at://<did>/<collection>/<rkey>`, scoped to one collection. Returns null
 * for a different collection, a malformed DID/rkey, or anything that is not an
 * at-uri — which the caller turns into `InvalidRequest` rather than a lookup.
 */
export function parseEntityUri(
  uri: unknown,
  collection: string
): { did: string; rkey: string } | null {
  if (typeof uri !== 'string') return null;
  const match = AT_URI.exec(uri);
  if (!match) return null;
  const [, did, coll, rkey] = match;
  if (did === undefined || coll === undefined || rkey === undefined) return null;
  if (coll !== collection || !DID.test(did)) return null;
  if (!RKEY.test(rkey) || rkey === '.' || rkey === '..') return null;
  return { did, rkey };
}

/** Stored identifiers are jsonb; tolerate both parsed arrays and JSON text. */
function asIdentifiers(value: unknown): EntityIdentifier[] {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const identifiers: EntityIdentifier[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    if (!('issuer' in entry) || !('value' in entry)) continue;
    const issuer = entry.issuer;
    const id = entry.value;
    if (typeof issuer !== 'string' || issuer === '') continue;
    if (typeof id !== 'string' || id === '') continue;
    const url =
      'url' in entry && typeof entry.url === 'string' && entry.url !== '' ? entry.url : undefined;
    identifiers.push({ issuer, value: id, ...(url ? { url } : {}) });
  }
  return identifiers;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value).toISOString();
  }
  throw new Error(`unusable catalog timestamp ${String(value)}`);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

type ContributorRow = {
  uri: string;
  name: string;
  name_inverted: string | null;
  description: string | null;
  image_url: string | null;
  born: string | null;
  died: string | null;
  identifiers: unknown;
  created_at: Date;
  cid: string | null;
};

type PublisherRow = {
  uri: string;
  name: string;
  description: string | null;
  image_url: string | null;
  started: string | null;
  ended: string | null;
  identifiers: unknown;
  created_at: Date;
  cid: string | null;
};

const CONTRIBUTOR_COLUMNS = `
  c.at_uri AS uri, c.name, c.name_inverted, c.description, c.image_url,
  c.born, c.died, c.identifiers, c.created_at`;

const PUBLISHER_COLUMNS = `
  c.at_uri AS uri, c.name, c.description, c.image_url,
  c.started, c.ended, c.identifiers, c.created_at`;

function contributorView(row: ContributorRow): ContributorView {
  const cid = text(row.cid);
  const nameInverted = text(row.name_inverted);
  const description = text(row.description);
  const imageUrl = text(row.image_url);
  const born = text(row.born);
  const died = text(row.died);
  const identifiers = asIdentifiers(row.identifiers);
  return {
    uri: row.uri,
    ...(cid ? { cid } : {}),
    displayName: row.name,
    ...(nameInverted ? { nameInverted } : {}),
    ...(description ? { description } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(identifiers.length > 0 ? { identifiers } : {}),
    ...(born ? { born } : {}),
    ...(died ? { died } : {}),
    createdAt: timestamp(row.created_at)
  };
}

function publisherView(row: PublisherRow): PublisherView {
  const cid = text(row.cid);
  const description = text(row.description);
  const imageUrl = text(row.image_url);
  const started = text(row.started);
  const ended = text(row.ended);
  const identifiers = asIdentifiers(row.identifiers);
  return {
    uri: row.uri,
    ...(cid ? { cid } : {}),
    name: row.name,
    ...(description ? { description } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(identifiers.length > 0 ? { identifiers } : {}),
    ...(started ? { started } : {}),
    ...(ended ? { ended } : {}),
    createdAt: timestamp(row.created_at)
  };
}

async function getOne<Row>(
  pool: EntityQueryable,
  uri: unknown,
  collection: string,
  table: string,
  columns: string
): Promise<Row | null> {
  if (parseEntityUri(uri, collection) === null) {
    throw new EntityUriError(`uri must be an ${collection} at-uri`);
  }
  const result = await pool.query(
    `SELECT ${columns}, k.cid
       FROM ${table} c
       LEFT JOIN pds_cids k ON k.uri = c.at_uri
      WHERE c.at_uri = $1`,
    [uri]
  );
  // pg rows are untyped; the SELECT column list above is the row contract.
  const rows = result.rows as Row[];
  return rows[0] ?? null;
}

export async function getContributor(
  pool: EntityQueryable,
  uri: unknown
): Promise<ContributorView | null> {
  const row = await getOne<ContributorRow>(
    pool,
    uri,
    CONTRIBUTOR_COLLECTION,
    'contributors',
    CONTRIBUTOR_COLUMNS
  );
  return row === null ? null : contributorView(row);
}

export async function getPublisher(
  pool: EntityQueryable,
  uri: unknown
): Promise<PublisherView | null> {
  const row = await getOne<PublisherRow>(
    pool,
    uri,
    PUBLISHER_COLLECTION,
    'publishers',
    PUBLISHER_COLUMNS
  );
  return row === null ? null : publisherView(row);
}

async function resolveEntity<Row, T>(
  pool: EntityQueryable,
  { table, columns, view }: { table: string; columns: string; view: (row: Row) => T },
  input: { identifiers: EntityIdentifier[]; offset: number; limit: number }
): Promise<EntityResults<T>> {
  // One jsonb[] parameter carries every pair. Each element is itself a
  // single-pair jsonb array: `@>` tests array containment, and extra keys such
  // as `url` are ignored by the containment check.
  const pairs = input.identifiers.map(({ issuer, value }) =>
    JSON.stringify([{ issuer, value }])
  );
  const page = await pool.query(
    `SELECT ${columns}, NULL::text AS cid
       FROM ${table} c
      WHERE c.identifiers @> ANY($1::jsonb[])
      ORDER BY lower(c.name), c.at_uri
      LIMIT $2 OFFSET $3`,
    [pairs, input.limit + 1, input.offset]
  );
  const counted =
    input.offset === 0
      ? await pool.query(
          `SELECT count(*)::int AS n
             FROM ${table} c
            WHERE c.identifiers @> ANY($1::jsonb[])`,
          [pairs]
        )
      : null;
  const rows = page.rows as Row[]; // pg rows are untyped; the SELECT list is the contract
  const items = rows.slice(0, input.limit).map(view);
  return {
    items,
    hasMore: rows.length > input.limit,
    ...(counted ? { total: Number(counted.rows[0]?.n ?? 0) } : {})
  };
}

export async function resolveContributors(
  pool: EntityQueryable,
  input: { identifiers: EntityIdentifier[]; offset: number; limit: number }
): Promise<EntityResults<ContributorView>> {
  return resolveEntity<ContributorRow, ContributorView>(
    pool,
    { table: 'contributors', columns: CONTRIBUTOR_COLUMNS, view: contributorView },
    input
  );
}

export async function resolvePublishers(
  pool: EntityQueryable,
  input: { identifiers: EntityIdentifier[]; offset: number; limit: number }
): Promise<EntityResults<PublisherView>> {
  return resolveEntity<PublisherRow, PublisherView>(
    pool,
    { table: 'publishers', columns: PUBLISHER_COLUMNS, view: publisherView },
    input
  );
}

async function searchEntity<Row, T>(
  pool: EntityQueryable,
  { table, columns, view }: { table: string; columns: string; view: (row: Row) => T },
  input: { q: string; limit: number; cursor?: string }
): Promise<SearchResults<T>> {
  const q = input.q.trim();
  if (q === '') throw new EntityQueryError('q is required');
  const offset = decodeOffsetCursor(input.cursor);
  // A name hit and an identifier-value hit are two index-backed sets, joined
  // instead of `OR`ed: an `OR` with an `EXISTS` branch can use no index, so the
  // whole table was read and the subquery ran per row. The non-empty guard
  // removes no result — an empty array has no element to match — and lets the
  // identifier branch ride the partial index that skips rows without one.
  const result = await pool.query(
    `WITH candidates AS (
       SELECT c.id FROM ${table} c WHERE c.name ILIKE $1
       UNION
       SELECT c.id FROM ${table} c
        WHERE c.identifiers <> '[]'::jsonb
          AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(c.identifiers) AS i(entry)
                 WHERE i.entry->>'value' ILIKE $1
              )
     )
     SELECT ${columns}, NULL::text AS cid
       FROM ${table} c
       JOIN candidates k ON k.id = c.id
      ORDER BY CASE
                 WHEN lower(c.name) = lower($2) THEN 0
                 WHEN c.name ILIKE $3 THEN 1
                 ELSE 2
               END,
               lower(c.name), c.at_uri
      LIMIT $4 OFFSET $5`,
    [likePattern(q), q, likePrefix(q), input.limit + 1, offset]
  );
  const rows = result.rows as Row[]; // pg rows are untyped; the SELECT list is the contract
  const items = rows.slice(0, input.limit).map(view);
  return {
    items,
    ...(rows.length > input.limit
      ? { cursor: encodeOffsetCursor(offset + items.length) }
      : {})
  };
}

export async function searchContributors(
  pool: EntityQueryable,
  input: { q: string; limit: number; cursor?: string }
): Promise<SearchResults<ContributorView>> {
  return searchEntity<ContributorRow, ContributorView>(
    pool,
    { table: 'contributors', columns: CONTRIBUTOR_COLUMNS, view: contributorView },
    input
  );
}

export async function searchPublishers(
  pool: EntityQueryable,
  input: { q: string; limit: number; cursor?: string }
): Promise<SearchResults<PublisherView>> {
  return searchEntity<PublisherRow, PublisherView>(
    pool,
    { table: 'publishers', columns: PUBLISHER_COLUMNS, view: publisherView },
    input
  );
}

/** `net.olamaelcu.livtet.biblio.defs#bookView`. */
export type BookView = { uri: string; edition: CatalogBookView };

export type BookResults = { items: BookView[]; cursor?: string; total?: number };

/**
 * Every edition credited to one contributor, across all roles.
 *
 * The contributor is resolved by its exact `at_uri` (the caller has already
 * validated the collection); no row is `null`, which the route maps to 404. The
 * join is `EXISTS`, so a person credited twice on one edition appears once.
 * Default order is `books.created_at DESC, uri ASC` — stable for offset
 * paging and newest-first for display. `sort`/`order` and `language` are the
 * same ones `searchEditions` accepts (`editionOrderBy` /
 * `editionLanguageClause`), and `total` counts what the filters returned. Only
 * the first page carries a total.
 */
export async function listEditionsByContributor(
  pool: EntityQueryable,
  input: {
    contributor: string;
    /** Union language claim, matched on the primary subtag; absent means no filter. */
    language?: string;
    sort?: BookSort;
    order?: BookSortOrder;
    offset: number;
    limit: number;
    /** Public origin for `/api/covers` URLs; absent keeps provider URLs. */
    coversBaseUrl?: string;
  }
): Promise<BookResults | null> {
  const found = (
    await pool.query('SELECT id FROM contributors WHERE at_uri = $1', [input.contributor])
  ).rows as { id: number | string }[];
  const contributorId = found[0]?.id;
  if (contributorId === undefined) return null;

  const params: Array<string | number> = [];
  const push = (value: string | number): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // The credit is the listing's own predicate; the language filter and the
  // order are the shared ones, so this page filters and sorts exactly like
  // `searchEditions`.
  const where = [
    `EXISTS (
              SELECT 1 FROM edition_contributors ec
               WHERE ec.edition_uri = e.uri AND ec.contributor_id = ${push(contributorId)}
            )`,
    ...(input.language ? [editionLanguageClause(input.language, push)] : [])
  ].join(' AND ');

  const limit = push(input.limit + 1);
  const offset = push(input.offset);
  const ordering = editionOrderBy({
    sort: input.sort,
    order: input.order,
    // `created_at DESC` is this method's own order, which is what `relevance`
    // means for a listing with no query to rank against.
    fallback: 'e.created_at DESC, e.uri ASC'
  });

  const page = await pool.query(
    `SELECT ${BOOK_COLUMNS}
       FROM books e
       ${BOOK_SHAPE_JOIN}
       ${BOOK_COVERS_JOIN}
      WHERE ${where}
      ORDER BY ${ordering}
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const rows = (page.rows as BookRow[]).slice(0, input.limit);

  // The same predicate as the page, so a language filter narrows the total too.
  // A first page shorter than `limit` is the whole listing, so its length is the
  // exact total and the count (which repeats the same semi-join over the
  // catalogue) is not worth running.
  const counted =
    input.offset === 0 && rows.length === input.limit
      ? await pool.query(
          `SELECT count(*)::int AS n
       FROM books e
       ${BOOK_SHAPE_JOIN}
            WHERE ${where}`,
          params.slice(0, params.length - 2)
        )
      : null;
  const views = await hydrate(pool, rows, input.coversBaseUrl ?? '');
  const items = rows.flatMap((row, index) => {
    const edition = views[index];
    return edition === undefined ? [] : [{ uri: row.uri, edition }];
  });

  return {
    items,
    ...(page.rows.length > input.limit
      ? { cursor: encodeOffsetCursor(input.offset + items.length) }
      : {}),
    ...(input.offset === 0
      ? { total: counted ? Number(counted.rows[0]?.n ?? 0) : rows.length }
      : {})
  };
}
