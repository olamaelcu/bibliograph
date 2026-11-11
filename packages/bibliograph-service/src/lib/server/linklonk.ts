// "For You" personalisation via a LinkLonk-style collaborative-filtering walk.
//
// Design: https://linklonk.com/item/3292763817660940288
//
// The walk starts at the viewer and makes three hops over a graph whose
// nodes are sources (readers) and whose edges are their upvoted items:
//
//   1. into one of the items the viewer upvoted
//   2. into one of the sources that upvoted that item *before* the viewer
//   3. into one of the items that source upvoted
//
// Each branch divides the path probability by the branching factor; an item's
// score is the sum of the path probabilities reaching it. Items the viewer
// downvoted walk the same route with a negative weight.
//
// Mapping to bibliograph's data:
//   item    = a catalog edition, addressed by its Bookhive hive id (`bk_…`)
//   upvote  = bookhive finished/reading, biblioapp shelving read/reading,
//             or a review with rating >= 6 (or none)
//   downvote = abandoned / dnf / rating <= 5
//   source  = the reader who wrote the record
//
// The viewer's own signals come from their PDS (fresh); the graph universe
// comes from the local mirror (~144k Bookhive records, 99% of whose upvotes
// map to a catalog edition via `rkey = 'bh.' || hive`). A malformed row is
// skipped, never fatal; a missing hive is invisible, not an error.

import { inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db as defaultDb } from './db';
import { editions } from './db/schema';
import type { DbExecutor } from './stats';
import { pdsClient } from './pds/resolve';
import type { RecommendationHit } from './recommendation';

const UPVOTE_STATUSES: readonly string[] = [
  'buzz.bookhive.defs#finished',
  'finished',
  'buzz.bookhive.defs#reading',
  'reading',
];
const DOWNVOTE_STATUSES: readonly string[] = [
  'buzz.bookhive.defs#abandoned',
  'abandoned',
];

const HIVE_PATTERN = /bk_[A-Za-z0-9]+$/;
const GRAPH_TTL_MS = 10 * 60 * 1000;
/** Bound for the viewer's own signals — a pathological repo is cut off. */
const MAX_VIEWER_SIGNALS = 500;
/** Bound for the candidate page this walk emits. */
const MAX_WALK_HITS = 128;
const PDS_TIMEOUT_MS = 10_000;

function hiveOf(uri: unknown): string | null {
  if (typeof uri !== 'string') return null;
  const match = HIVE_PATTERN.exec(uri);
  return match ? match[0] : null;
}

const BOOKHIVE_COLLECTION = 'buzz.bookhive.book';
const SHELVING_COLLECTION = 'net.olamaelcu.livtet.biblio.bookShelving';
const REVIEW_COLLECTION = 'net.olamaelcu.livtet.biblio.bookReview';
const SHELF_UP = new Set(['read', 'reading']);
const SHELF_DOWN = new Set(['dnf']);

type PdsClient = Awaited<ReturnType<typeof pdsClient>>['client'];

function recordListPdsPages(
  client: PdsClient,
  did: string,
  collection: `${string}.${string}.${string}`,
  log: Logger,
): Promise<Record<string, unknown>[]> {
  // One bounded PDS scan per collection, best-effort: a page that fails keeps
  // the pages already read, and the caller merges the partial set.
  const collected: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  return (async () => {
    for (let page = 0; page < 25; page += 1) {
      let raw: unknown;
      try {
        raw = await client.get('com.atproto.repo.listRecords', {
          params: {
            repo: did as `did:${string}:${string}`,
            collection,
            limit: 100,
            cursor,
          },
          signal: AbortSignal.timeout(PDS_TIMEOUT_MS),
        });
      } catch (err) {
        log.warn({ err, did, collection, page }, 'linklonk: PDS page failed');
        return collected;
      }
      const wrapper = raw as { ok?: unknown; data?: unknown } | undefined;
      const body = wrapper && wrapper.ok === true && wrapper.data && typeof wrapper.data === 'object'
        ? wrapper.data
        : raw;
      if (
        !body ||
        typeof body !== 'object' ||
        !Array.isArray((body as { records?: unknown }).records)
      ) {
        log.warn({ did, collection, page }, 'linklonk: PDS page shape unexpected');
        return collected;
      }
      const records = (body as { records: Array<{ value?: unknown }> }).records;
      for (const record of records) {
        if (record.value && typeof record.value === 'object') {
          collected.push(record.value as Record<string, unknown>);
        }
      }
      const next = (body as { cursor?: unknown }).cursor;
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
    return collected;
  })();
}

function statusOf(value: Record<string, unknown>): string {
  return typeof value['status'] === 'string' ? value['status'] : '';
}

function createdAtOf(value: Record<string, unknown>): number {
  return typeof value['createdAt'] === 'string' ? Date.parse(value['createdAt']) || 0 : 0;
}

function bookUriOf(value: Record<string, unknown>): string | undefined {
  const raw = value['book'];
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const options = raw as Record<string, unknown>;
    if (typeof options['uri'] === 'string') return options['uri'];
    if (typeof options['ref'] === 'string') return options['ref'];
  }
  return undefined;
}

/** Reading status, from `metadata.status` (authoritative) or the shelf rkey. */
function shelfStatusOf(value: Record<string, unknown>): string {
  const metadata = value['metadata'];
  if (metadata && typeof metadata === 'object') {
    const status = (metadata as Record<string, unknown>)['status'];
    if (typeof status === 'string' && status) return status;
  }
  const shelf = value['shelf'];
  if (typeof shelf === 'string') {
    const last = shelf.split('/').pop();
    if (last) return last;
  }
  return '';
}

function tsOf(value: Record<string, unknown>, ...fallbackKeys: string[]): number {
  for (const key of fallbackKeys) {
    const raw = value[key];
    if (typeof raw === 'string') {
      const ts = Date.parse(raw);
      if (!Number.isNaN(ts) && ts > 0) return ts;
    }
  }
  return 0;
}

/** Catalog editions → hive ids, for records that name the edition URI directly. */
async function mapEditionsToHives(
  uris: readonly string[],
  log: Logger,
  db: DbExecutor,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rest: string[] = [];
  for (const uri of uris) {
    const rkey = uri.split('/').pop() ?? '';
    if (rkey.startsWith('bh.')) out.set(uri, rkey.slice('bh.'.length));
    else rest.push(uri);
  }
  for (let i = 0; i < rest.length; i += 500) {
    const chunk = rest.slice(i, i + 500);
    const rows = await db
      .select({ uri: editions.uri, identifiers: editions.identifiers })
      .from(editions)
      .where(inArray(editions.uri, chunk));
    for (const row of rows) {
      if (!Array.isArray(row.identifiers)) continue;
      for (const identifier of row.identifiers) {
        if (!identifier || typeof identifier !== 'object') continue;
        const entry = identifier as Record<string, unknown>;
        if (entry['type'] === 'bookhive.buzz' && typeof entry['value'] === 'string') {
          out.set(row.uri, entry['value']);
          break;
        }
      }
    }
  }
  if (rest.length > 0 && out.size === 0) {
    log.warn('linklonk: no biblio shelved edition mapped to a hive');
  }
  return out;
}

/** The viewer's own signals, read from their repo (fresh). */
export interface ViewerSignals {
  /** hive → createdAt (max wins), for the "sources who were first" test. */
  up: Map<string, number>;
  /** hives the reader downvoted; they detract. Down votes outrank up votes. */
  down: Map<string, number>;
}

/**
 * Read the viewer's signals from their repo. `null` means the repo could not
 * be read at all; a partially read repo returns what it had. Three collections
 * feed the walk — Bookhive's books, the biblioapp's shelvings, its reviews:
 *
 *   up    bookhive finished/reading · shelving read/reading · review rating ≥ 6
 *         (or no rating) · the reader's engagement is the endorsement
 *   down  bookhive abandoned · shelving dnf · review rating ≤ 5
 *   union down beats up on conflict, latest record wins per hive
 *
 * Biblio records point at a catalog edition URI; the hive is recovered via the
 * `bh.` rkey convention, or via the edition's `bookhive.buzz` identifier.
 */
export async function readViewerSignals(
  did: string,
  log: Logger,
  db: DbExecutor = defaultDb,
): Promise<ViewerSignals | null> {
  let client;
  try {
    ({ client } = await pdsClient(did));
  } catch (err) {
    log.warn({ err, did }, 'linklonk: no PDS for reader');
    return null;
  }
  const up = new Map<string, number>();
  const down = new Map<string, number>();
  const put = (bucket: Map<string, number>, hive: string, ts: number): void => {
    bucket.set(hive, Math.max(bucket.get(hive) ?? 0, ts));
  };

  // 1. Bookhive — the same collection the mirror holds, so identifiers align
  //    one-to-one.
  for (const record of await recordListPdsPages(client, did, BOOKHIVE_COLLECTION, log)) {
    const hive = hiveOf(record['hiveBookUri']);
    if (!hive) continue;
    const status = statusOf(record);
    const ts = createdAtOf(record);
    if (UPVOTE_STATUSES.includes(status)) put(up, hive, ts);
    else if (DOWNVOTE_STATUSES.includes(status)) put(down, hive, ts);
  }

  // 2. Biblioapp records — mapped to hives in one pass.
  const shelving = await recordListPdsPages(client, did, SHELVING_COLLECTION, log);
  const reviews = await recordListPdsPages(client, did, REVIEW_COLLECTION, log);
  interface Candidate {
    uri: string;
    bucket: 'up' | 'down';
    ts: number;
  }
  const candidates: Candidate[] = [];
  for (const record of shelving) {
    const status = shelfStatusOf(record);
    const bucket = SHELF_UP.has(status) ? 'up' : SHELF_DOWN.has(status) ? 'down' : null;
    if (!bucket) continue;
    const uri = bookUriOf(record);
    if (!uri) continue;
    candidates.push({ uri, bucket, ts: tsOf(record, 'updatedAt', 'createdAt') });
  }
  for (const record of reviews) {
    const uri = bookUriOf(record);
    if (!uri) continue;
    const rating = typeof record['rating'] === 'number' ? record['rating'] : Number(record['rating']);
    candidates.push({
      uri,
      bucket: Number.isFinite(rating) && rating <= 5 ? 'down' : 'up',
      ts: tsOf(record, 'createdAt', 'updatedAt'),
    });
  }
  if (candidates.length > 0) {
    const hiveByUri = await mapEditionsToHives(
      [...new Set(candidates.map((candidate) => candidate.uri))],
      log,
      db,
    );
    for (const candidate of candidates) {
      const hive = hiveByUri.get(candidate.uri);
      if (!hive) continue;
      put(candidate.bucket === 'up' ? up : down, hive, candidate.ts);
    }
  }

  // 3. Down votes outrank up votes on the same book; keep newest if over cap.
  for (const hive of down.keys()) up.delete(hive);
  if (up.size + down.size > MAX_VIEWER_SIGNALS) {
    const all: Array<{ hive: string; ts: number; bucket: 'up' | 'down' }> = [
      ...[...up].map(([hive, ts]) => ({ hive, ts, bucket: 'up' as const })),
      ...[...down].map(([hive, ts]) => ({ hive, ts, bucket: 'down' as const })),
    ]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_VIEWER_SIGNALS);
    up.clear();
    down.clear();
    for (const { hive, ts, bucket } of all) put(bucket === 'up' ? up : down, hive, ts);
  }
  return { up, down };
}

/** The network graph, loaded from the local mirror, TTL-cached. */
export interface Graph {
  /** Per hive, the upvoting readers with the createdAt ts of their record. */
  sourcesByBook: Map<string, Array<{ did: string; ts: number }>>;
  /** Per reader, the hives they upvoted (step-3 branching factor). */
  upBySource: Map<string, string[]>;
  // No edition map here on purpose: the walk scores hives first, then maps
  // only the top-ranked ones — a single small query per feed request.
}

let graphCache: { graph: Graph; expiresAt: number } | null = null;

/** Load the network graph from the mirror, TTL-cached. One id→edition map. */
export async function loadGraph(
  log: Logger,
  db: DbExecutor = defaultDb,
): Promise<Graph> {
  if (graphCache && graphCache.expiresAt > Date.now()) return graphCache.graph;
  const statusLiterals = [...UPVOTE_STATUSES, ...DOWNVOTE_STATUSES]
    .map((status) => `'${status}'`)
    .join(', ');
  const rows = await db.execute<{
    did: string;
    status: string;
    hive: string;
    created_at: string | null;
  }>(sql.raw(`
    SELECT did,
           value->>'status' AS status,
           regexp_replace(value->>'hiveBookUri', '.*/(bk_[A-Za-z0-9]+)$', '\\1') AS hive,
           value->>'createdAt' AS created_at
    FROM records
    WHERE collection = 'buzz.bookhive.book'
      AND value->>'hiveBookUri' ~ 'bk_[A-Za-z0-9]+$'
      AND value->>'status' IN (${statusLiterals})
  `));
  const sourcesByBook = new Map<string, Array<{ did: string; ts: number }>>();
  const upBySource = new Map<string, string[]>();
  for (const row of rows.rows) {
    if (!UPVOTE_STATUSES.includes(row.status)) continue;
    const ts = Date.parse(row.created_at ?? '') || 0;
    const entry = { did: row.did, ts };
    const list = sourcesByBook.get(row.hive);
    if (list) list.push(entry);
    else sourcesByBook.set(row.hive, [entry]);
    const mine = upBySource.get(row.did);
    if (mine) mine.push(row.hive);
    else upBySource.set(row.did, [row.hive]);
  }
  const graph: Graph = { sourcesByBook, upBySource };
  graphCache = { graph, expiresAt: Date.now() + GRAPH_TTL_MS };
  log.info(
    { upEdges: upBySource.size, books: sourcesByBook.size, stage: 'linklonk' },
    'linklonk graph loaded',
  );
  return graph;
}

/**
 * The ranked catalog hits for a viewer, LinkLonk order. Empty when the viewer
 * and the world share no signal.
 */
export async function linklonkHits(
  viewerDid: string,
  signals: ViewerSignals,
  wanted: number,
  log: Logger,
  db: DbExecutor = defaultDb,
): Promise<RecommendationHit[]> {
  if (signals.up.size === 0 && signals.down.size === 0) return [];
  const graph = await loadGraph(log, db);
  const score = new Map<string, number>();
  const walk = (hive: string, viewerTs: number, sign: 1 | -1): void => {
    const srcs = graph.sourcesByBook.get(hive);
    if (!srcs) return;
    // Sources ahead of the viewer keep the walk honest: you inherit from
    // curators who were already right about the book before you saw it.
    const prior = srcs.filter((s) => s.did !== viewerDid && s.ts > 0 && s.ts < viewerTs);
    if (prior.length === 0) return;
    const n = prior.length;
    for (const source of prior) {
      const items = graph.upBySource.get(source.did);
      if (!items || items.length === 0) continue;
      const w = (sign / n) / items.length;
      for (const item of items) {
        if (item === hive) continue;
        score.set(item, (score.get(item) ?? 0) + w);
      }
    }
  };
  for (const [hive, ts] of signals.up) walk(hive, ts, +1);
  for (const [hive, ts] of signals.down) walk(hive, ts, -1);
  // The viewer's own books are not recommendations.
  for (const hive of signals.up.keys()) score.delete(hive);
  for (const hive of signals.down.keys()) score.delete(hive);

  const ranked: Array<{ hive: string; value: number }> = [];
  for (const [hive, value] of score) {
    ranked.push({ hive, value });
  }
  ranked.sort((a, b) => b.value - a.value);
  const cap = Math.min(MAX_WALK_HITS, Math.max(wanted, 1) * 2);
  const top = ranked.slice(0, cap).filter(({ value }) => value > 0);
  if (top.length === 0) return [];
  const hives = top.map(({ hive }) => hive);
  const editions = await db.execute<{
    uri: string;
    tid: string;
    has_cover: boolean;
    hive: string;
  }>(sql`
    SELECT uri, tid, (cover_image_url IS NOT NULL) AS has_cover,
           regexp_replace(rkey, '^bh\\.', '') AS hive
    FROM editions
    WHERE rkey = ANY(ARRAY[${sql.join(hives.map((h) => sql`${'bh.' + h}`), sql`, `)}])
  `);
  const byHive = new Map(editions.rows.map((row) => [row.hive, row]));
  const hits: RecommendationHit[] = [];
  for (const { hive, value } of top) {
    const edition = byHive.get(hive);
    if (!edition) continue;
    hits.push({
      uri: edition.uri,
      tid: edition.tid,
      overlap: Math.max(1, Math.round(value * 1_000_000)),
      hasCover: edition.has_cover === true,
    });
    if (hits.length >= wanted) break;
  }
  return hits;
}

/** Test seam: the graph lives for the process. */
export function _resetLinklonkCacheForTesting(): void {
  graphCache = null;
}
