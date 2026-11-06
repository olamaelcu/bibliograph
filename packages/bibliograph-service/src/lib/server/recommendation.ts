// "For You" book recommendations.
//
// The feed answers one question: given the books a reader is reading now and
// the books they have finished, which catalog editions they have never shelved
// should they see next?
//
// The similarity signal is the work's `subjects` (the genre/tag vocabulary the
// catalog ingests from OpenLibrary and Google Books). Embeddings would be the
// richer signal, but this service has no model runtime and no vector column:
// every embedding path would be an in-process download and a full catalog
// re-embed on each deploy. Subject overlap is the fallback the design named for
// exactly that case, and it needs nothing but the catalog this service already
// owns.
//
// Reading data comes from the reader's own repo, not the mirror: TAP mirrors
// only `buzz.bookhive.book`, so `bookShelving`/`shelfItem`/`bookReview` rows in
// the local `records` table are whatever a backfill once copied. A feed that
// answers "what should I read next" must see the shelf the reader changed five
// minutes ago, so it reads the PDS the same way the social feeds read follows.

import { sql } from 'drizzle-orm';
import type { Nsid } from '@atcute/lexicons';
import { db as defaultDb } from './db';
import { pdsClient } from './pds/resolve';
import { createLogger } from './logger';
import type { DbExecutor } from './stats';

const log = createLogger('web');

const SHELVING_COLLECTION = 'net.olamaelcu.livtet.biblio.bookShelving';
const SHELF_ITEM_COLLECTION = 'net.olamaelcu.livtet.biblio.shelfItem';
const REVIEW_COLLECTION = 'net.olamaelcu.livtet.biblio.bookReview';

/** Status shelf rkeys; `metadata.status` is authoritative when both exist. */
const READING_STATUS = 'reading';
const READ_STATUS = 'read';

const PDS_READ_TIMEOUT_MS = 10_000;
/** 100 records per page, and a repo that needs more than this is not a shelf. */
const PDS_PAGE_SIZE = 100;
const MAX_PDS_PAGES = 10;

/** The feed is a single page; the design caps it at 30 cards. */
export const RECOMMENDATION_LIMIT = 30;

/**
 * How long a reader's library stands. Shelves change at human pace, and every
 * miss costs three bounded PDS scans, so a minute of staleness buys a lot of
 * upstream quiet.
 */
const LIBRARY_TTL_MS = 60_000;
const LIBRARY_CACHE_MAX = 512;
const libraryCache = new Map<string, { value: ViewerLibrary; expiresAt: number }>();

/** The reader's shelf, as book URIs, split by what the books mean to them. */
export interface ViewerLibrary {
  /** Books being read right now — the strongest signal. */
  reading: string[];
  /** Books finished, including reviewed ones. */
  read: string[];
  /** Every book the reader has any record for; never recommended back. */
  shelved: string[];
}

/** One ranked catalog hit, before the exclusions and the cap are applied. */
export interface RecommendationHit {
  uri: string;
  tid: string;
  /** How many of the seed's subjects this work shares. */
  overlap: number;
  hasCover: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/** The catalog edition a shelving, shelfItem or review record names. */
function bookUriOf(value: Record<string, unknown>): string | undefined {
  const raw = value.book;
  if (typeof raw === 'string') return raw;
  const ref = asRecord(raw);
  return typeof ref.uri === 'string' ? ref.uri : undefined;
}

/**
 * The reading status a shelving record carries. `metadata.status` wins; the
 * older records predate it, and their status lives in the shelf record's rkey
 * (`…/biblio.shelf/reading`).
 */
function readingStatusOf(value: Record<string, unknown>): string | undefined {
  const status = asRecord(value.metadata).status;
  if (typeof status === 'string' && status) return status;
  const shelf = value.shelf;
  if (typeof shelf !== 'string') return undefined;
  return shelf.slice(shelf.lastIndexOf('/') + 1) || undefined;
}

/**
 * Every `value` in one collection of one repo, or `null` when the repo could
 * not be read. `null` is not an empty shelf: a signed-in reader whose PDS is
 * unreachable must not be told their library is empty and handed the catalog.
 */
async function listPdsValues(
  did: string,
  collection: Nsid,
): Promise<unknown[] | null> {
  let client;
  try {
    ({ client } = await pdsClient(did));
  } catch (err) {
    log.warn({ err, did, collection }, 'recommendation: no PDS for reader');
    return null;
  }

  const values: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PDS_PAGES; page += 1) {
    let raw: unknown;
    try {
      raw = await client.get('com.atproto.repo.listRecords', {
        params: {
          repo: did as `did:${string}:${string}`,
          collection,
          limit: PDS_PAGE_SIZE,
          cursor,
        },
        signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
      });
    } catch (err) {
      // A partial read is still a shelf; a total failure is not.
      log.warn({ err, did, collection, page }, 'recommendation: PDS page failed');
      return values.length > 0 ? values : null;
    }
    const records = asRecord(raw).records;
    if (!Array.isArray(records)) {
      log.warn({ did, collection }, 'recommendation: listRecords shape unexpected');
      return values.length > 0 ? values : null;
    }
    for (const record of records) {
      values.push(asRecord(record).value);
    }
    const next = asRecord(raw).cursor;
    if (typeof next !== 'string' || next === '') break;
    cursor = next;
  }
  return values;
}

function cachedLibrary(did: string): ViewerLibrary | undefined {
  const hit = libraryCache.get(did);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    libraryCache.delete(did);
    return undefined;
  }
  return hit.value;
}

function rememberLibrary(did: string, value: ViewerLibrary): void {
  if (libraryCache.size >= LIBRARY_CACHE_MAX) {
    const now = Date.now();
    for (const [key, entry] of libraryCache) {
      if (entry.expiresAt <= now) libraryCache.delete(key);
    }
    // Still full: drop the oldest insertion. Map iteration is insertion order.
    const oldest = libraryCache.keys().next().value;
    if (oldest !== undefined) libraryCache.delete(oldest);
  }
  libraryCache.set(did, { value, expiresAt: Date.now() + LIBRARY_TTL_MS });
}

/**
 * The reader's library, read from their repo. `null` means the repo could not
 * be read at all — the caller reports an empty feed rather than a catalogue.
 */
export async function readViewerLibrary(did: string): Promise<ViewerLibrary | null> {
  const cached = cachedLibrary(did);
  if (cached) return cached;

  const [shelving, shelfItems, reviews] = await Promise.all([
    listPdsValues(did, SHELVING_COLLECTION),
    listPdsValues(did, SHELF_ITEM_COLLECTION),
    listPdsValues(did, REVIEW_COLLECTION),
  ]);
  if (!shelving && !shelfItems && !reviews) return null;

  const reading = new Set<string>();
  const read = new Set<string>();
  const shelved = new Set<string>();

  for (const raw of shelving ?? []) {
    const value = asRecord(raw);
    const bookUri = bookUriOf(value);
    if (!bookUri) continue;
    shelved.add(bookUri);
    const status = readingStatusOf(value);
    if (status === READING_STATUS) reading.add(bookUri);
    else if (status === READ_STATUS) read.add(bookUri);
  }
  for (const raw of shelfItems ?? []) {
    const bookUri = bookUriOf(asRecord(raw));
    if (bookUri) shelved.add(bookUri);
  }
  // A review is proof the book was read, whether or not its shelving record
  // survived a migration.
  for (const raw of reviews ?? []) {
    const bookUri = bookUriOf(asRecord(raw));
    if (!bookUri) continue;
    shelved.add(bookUri);
    if (!reading.has(bookUri)) read.add(bookUri);
  }

  const library: ViewerLibrary = {
    reading: [...reading],
    read: [...read],
    shelved: [...shelved],
  };
  rememberLibrary(did, library);
  return library;
}

/**
 * The catalog's `tid` for each uri, so a book shelved under one provider's
 * namespace is still recognised when the candidate list names another. Unknown
 * uris simply have no tid — nothing in the catalog can be that book.
 */
async function tidsFor(
  uris: readonly string[],
  exec: DbExecutor,
): Promise<Set<string>> {
  if (uris.length === 0) return new Set();
  const result = await exec.execute<{ tid: string }>(sql`
    SELECT COALESCE(e.tid, a.tid) AS tid
    FROM unnest(ARRAY[${sql.join(uris.map((uri) => sql`${uri}`), sql`, `)}]) AS input(uri)
    LEFT JOIN editions e ON e.uri = input.uri
    LEFT JOIN edition_aliases a ON a.uri = input.uri
    WHERE COALESCE(e.tid, a.tid) IS NOT NULL
  `);
  return new Set(result.rows.map((row) => row.tid));
}

/**
 * Catalog editions of works that share genres/tags with `seedUris`, ranked by
 * how many subjects they share.
 *
 * The scoring runs over `works`, not `editions`: a work is where subjects live,
 * every edition of a work is one recommendation, and the seeded candidate set
 * is bounded before the (indexed) join back to editions. Editions of the seeds'
 * own works are excluded outright — another edition of the book in your hand is
 * not a new book.
 */
async function candidateHits(
  seedUris: readonly string[],
  wanted: number,
  exec: DbExecutor,
): Promise<RecommendationHit[]> {
  if (seedUris.length === 0) return [];
  const result = await exec.execute<{
    uri: string;
    tid: string;
    overlap: number;
    has_cover: boolean;
  }>(sql`
    WITH seed_works AS (
      SELECT DISTINCT work_uri
      FROM editions
      WHERE uri IN (${sql.join(seedUris.map((uri) => sql`${uri}`), sql`, `)})
        AND work_uri IS NOT NULL
    ),
    seed_subjects AS (
      SELECT DISTINCT lower(btrim(subject)) AS subject
      FROM works w
      JOIN seed_works sw ON sw.work_uri = w.uri
      CROSS JOIN LATERAL jsonb_array_elements_text(w.subjects) AS subject
      WHERE btrim(subject) <> ''
    ),
    scored AS (
      SELECT w.uri AS work_uri, count(*)::int AS overlap
      FROM works w
      CROSS JOIN LATERAL jsonb_array_elements_text(w.subjects) AS subject
      JOIN seed_subjects ss ON ss.subject = lower(btrim(subject))
      WHERE w.uri NOT IN (SELECT work_uri FROM seed_works)
        -- A work with no edition is not a recommendation. Filtering here keeps
        -- the LIMIT below counting only books the join can actually return:
        -- capping the works instead let link-less works fill every slot.
        AND EXISTS (SELECT 1 FROM editions e WHERE e.work_uri = w.uri)
      GROUP BY w.uri
    )
    SELECT e.uri, e.tid, s.overlap, (e.cover_image_url IS NOT NULL) AS has_cover
    FROM scored s
    JOIN editions e ON e.work_uri = s.work_uri
    ORDER BY s.overlap DESC, (e.cover_image_url IS NULL), e.uri
    LIMIT ${wanted}
  `);
  return result.rows.map((row) => ({
    uri: row.uri,
    tid: row.tid,
    overlap: Number(row.overlap),
    hasCover: row.has_cover === true,
  }));
}

/**
 * Merge the two ranked lists into one page.
 *
 * Active-read matches come first, then past reads; a book reachable from both
 * lists appears once, at its higher position. Everything the reader already has
 * a record for is dropped by `tid`, so a shelved edition and its candidate
 * alias cannot both surface.
 */
export function mergeRecommendations(params: {
  active: readonly RecommendationHit[];
  past: readonly RecommendationHit[];
  excludedTids: ReadonlySet<string>;
  excludedUris: ReadonlySet<string>;
  limit: number;
}): string[] {
  const { active, past, excludedTids, excludedUris, limit } = params;
  const cap = Math.min(Math.max(limit, 0), RECOMMENDATION_LIMIT);
  const picked: string[] = [];
  /** tid → index in `picked`, so a later edition can replace it in place. */
  const indexByTid = new Map<string, number>();
  const pickedHasCover: boolean[] = [];

  const consider = (hit: RecommendationHit): void => {
    if (excludedTids.has(hit.tid) || excludedUris.has(hit.uri)) return;
    const index = indexByTid.get(hit.tid);
    if (index === undefined) {
      if (picked.length >= cap) return;
      indexByTid.set(hit.tid, picked.length);
      picked.push(hit.uri);
      pickedHasCover.push(hit.hasCover);
      return;
    }
    // Same book, another edition: upgrade in place only when the edition held
    // so far has no cover, so the card is not blank when a covered edition of
    // the same book exists.
    if (hit.hasCover && !pickedHasCover[index]) {
      picked[index] = hit.uri;
      pickedHasCover[index] = true;
    }
  };

  for (const hit of active) consider(hit);
  for (const hit of past) consider(hit);
  return picked;
}

/**
 * Up to `limit` catalog edition uris, personalised by the reader's shelf.
 * Active reads are ranked on their own so their matches lead the page.
 */
export async function recommendBookUris(
  library: ViewerLibrary,
  limit: number,
  exec: DbExecutor = defaultDb,
): Promise<string[]> {
  const cap = Math.min(Math.max(limit, 1), RECOMMENDATION_LIMIT);
  if (library.reading.length === 0 && library.read.length === 0) return [];

  const excludedUris = new Set(library.shelved);
  const excludedTids = await tidsFor([...excludedUris], exec);
  // Over-fetch per list: exclusions and edition-level dedupe eat into the page.
  const wanted = cap * 4;
  const [active, past] = await Promise.all([
    candidateHits(library.reading, wanted, exec),
    candidateHits(library.read, wanted, exec),
  ]);

  return mergeRecommendations({
    active,
    past,
    excludedTids,
    excludedUris,
    limit: cap,
  });
}

/** Test seam: the library cache lives for the process. */
export function _resetRecommendationCacheForTesting(): void {
  libraryCache.clear();
}
