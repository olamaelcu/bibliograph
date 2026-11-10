// The reader directory behind `net.olamaelcu.livtet.biblio.searchActors`.
//
// Why this reads a table rather than deriving from `records`: the directory
// filters on handle / display name, and neither is in any record body the TAP
// mirror holds — profiles are not in the ingest filter, and a handle is not
// part of a book record at all. Resolving identity per request would put one
// outbound round trip behind every candidate. `actors` denormalizes what
// `scripts/backfill-actors.ts` resolves, so a page is one local query.
//
// The hard requirement of the endpoint: the `q` predicate and the `hasRecords`
// EXISTS probe live in the SAME WHERE as the actor listing, so ORDER BY /
// LIMIT / OFFSET apply after filtering. Trimming a fetched page afterwards
// would return short pages and skip rows between pages, which is why this
// module never post-filters.

import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db as defaultDb } from './db/index';
import { actors, records } from './db/schema';

export type ActorDirectoryDb = typeof defaultDb;

export const SEARCH_ACTORS_MIN_Q = 3;
export const SEARCH_ACTORS_MAX_Q = 200;
export const SEARCH_ACTORS_MAX_COLLECTIONS = 8;
export const SEARCH_ACTORS_DEFAULT_LIMIT = 25;
export const SEARCH_ACTORS_MAX_LIMIT = 100;

/** The public avatar URL shape `app.bsky.actor.getProfiles` answers with. */
const BSKY_AVATAR_BASE = 'https://cdn.bsky.app/img/avatar/plain';

export interface ActorRow {
  did: string;
  handle: string | null;
  displayName: string | null;
  description: string | null;
  avatarCid: string | null;
}

/** `defs#actorView`, restricted to the fields this endpoint fills. */
export interface ActorView {
  did: string;
  handle?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
}

export interface SearchActorsParams {
  q?: string | undefined;
  hasRecords?: readonly string[] | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface SearchActorsPage {
  actors: ActorView[];
  hasMore: boolean;
  total?: number;
}

export interface NormalizedSearchActorsParams {
  q: string | undefined;
  collections: string[];
  offset: number;
  limit: number;
}

/**
 * Escape the LIKE metacharacters, so a literal `%` or `_` in `q` matches itself
 * instead of widening the pattern. The escape character is the backslash, which
 * is what every `ESCAPE '\'` clause below names.
 */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** The avatar's blob CID, from the URL the public AppView serves it under. */
export function avatarCidFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const match = /\/img\/avatar\/plain\/[^/]+\/([^/@?]+)/.exec(url);
  return match?.[1] ?? null;
}

export function actorView(row: ActorRow): ActorView {
  return {
    did: row.did,
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.avatarCid ? { avatar: `${BSKY_AVATAR_BASE}/${row.did}/${row.avatarCid}` } : {}),
  };
}

export function normalizeSearchActorsParams(
  params: SearchActorsParams,
): NormalizedSearchActorsParams {
  const q = params.q?.trim();
  const limit = params.limit ?? SEARCH_ACTORS_DEFAULT_LIMIT;
  const offset = params.offset ?? 0;
  return {
    q: q ? q : undefined,
    collections: [...(params.hasRecords ?? [])],
    offset: Math.max(offset, 0),
    limit: Math.min(Math.max(limit, 1), SEARCH_ACTORS_MAX_LIMIT),
  };
}

/**
 * The filter every read in this module shares. Both halves are ordinary
 * predicates of the actor SELECT — the EXISTS is correlated on `actors.did`, so
 * Postgres probes `records_did_collection_idx` per candidate and never
 * materializes a join.
 */
export function actorsWhere(params: NormalizedSearchActorsParams): SQL | undefined {
  const clauses: SQL[] = [];
  if (params.q) {
    const contains = likeContains(params.q);
    clauses.push(
      or(
        eq(actors.did, params.q),
        sql`${actors.handle} ILIKE ${contains} ESCAPE '\\'`,
        sql`${actors.displayName} ILIKE ${contains} ESCAPE '\\'`,
      )!,
    );
  }
  if (params.collections.length > 0) {
    clauses.push(
      sql`exists (
        select 1
          from ${records}
         where ${records.did} = ${actors.did}
           and ${inArray(records.collection, params.collections)}
      )`,
    );
  }
  return clauses.length > 0 ? and(...clauses) : undefined;
}

export async function searchActors(
  rawParams: SearchActorsParams,
  db: ActorDirectoryDb = defaultDb,
): Promise<SearchActorsPage> {
  const params = normalizeSearchActorsParams(rawParams);

  // The page and the count are independent, so they run together.
  const pageQuery = buildActorPageQuery(db, params);
  const countQuery = params.offset === 0 ? buildActorCountQuery(db, params) : undefined;

  const [rows, counted] = await Promise.all([
    pageQuery,
    countQuery ?? Promise.resolve(undefined),
  ]);

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const total = counted?.[0]?.total;

  return {
    actors: page.map(actorView),
    hasMore,
    ...(total !== undefined ? { total } : {}),
  };
}

/**
 * The listing: `WHERE` (q + hasRecords) first, then order and pagination.
 * Exported so the shape can be asserted in tests without a database.
 *
 * `limit + 1` is the whole of `hasMore`: one extra row is cheaper than a second
 * count, and it cannot disagree with the page it describes.
 */
export function buildActorPageQuery(
  db: ActorDirectoryDb,
  params: NormalizedSearchActorsParams,
) {
  return db
    .select({
      did: actors.did,
      handle: actors.handle,
      displayName: actors.displayName,
      description: actors.description,
      avatarCid: actors.avatarCid,
    })
    .from(actors)
    .where(actorsWhere(params))
    // `did` is the immutable tiebreak: handles are refreshed by a daily job and
    // can change between pages, so handle alone would not be a total order.
    .orderBy(asc(sql`coalesce(${actors.handle}, ${actors.did})`), asc(actors.did))
    .limit(params.limit + 1)
    .offset(params.offset);
}

/** The first page's total, sharing the page's WHERE. */
export function buildActorCountQuery(
  db: ActorDirectoryDb,
  params: NormalizedSearchActorsParams,
) {
  return db
    .select({ total: sql<number>`count(*)::int` })
    .from(actors)
    .where(actorsWhere(params));
}
