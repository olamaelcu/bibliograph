// Backfill works for editions with no `work_uri`.
//
// Two phases, both always on:
//
//   Phase 1 — orphans (editions.work_uri IS NULL):
//     For each orphan: derive a search key from identifiers (ISBN preferred)
//     or title, query OpenLibrary's work search, pick the first candidate
//     whose title matches case-insensitively AND whose `first_publish_year`
//     is within ±2 years (or missing on both sides). A match is ingested as a
//     WorkItem (idempotent upsert keyed by deterministic URI) and the pair's
//     `editions.work_uri` / `work_cid` are written.
//
//     No match leaves the edition unlinked. A work invented from the edition's
//     own fields carries no subjects and no contributors, so it would occupy a
//     catalog row while telling callers nothing; `editions.work_uri` is an
//     AppView-internal join key (the served edition record does not carry
//     `work`), so NULL is the honest value for "the catalog does not know this
//     work".
//
//   Phase 2 — CID re-verify (editions.work_uri IS NOT NULL):
//     For each already-linked edition, load the work row, recompute its CID
//     from the column values and the contributor records they reference via
//     `cidForLex`, and persist if the recomputed CID differs from the stored
//     one. No-op when equal; safe to re-run.
//
// Re-runs are idempotent: Phase 1's `WHERE work_uri IS NULL` predicate means
// already-reconciled editions are skipped, and Phase 2 only writes when the
// CID actually drifts.
//
// `shardIndex` / `shardCount` split the scan by uri so several processes can
// walk disjoint slices of one large catalog. The predicate is deterministic
// across processes and restarts: `md5(uri)`'s first byte modulo the shard
// count, capped at 256 shards.
import type { Logger } from 'pino';
import type { SQL } from 'drizzle-orm';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { editionWorkBackfill, editions, works } from '../db/schema';
import type { DbExecutor } from '../stats';
import { PUBLISHER_DID } from '../did';
import { OpenLibrarySource } from '../search/open-library-source';
import type { WorkItem, Identifier } from '../search/types';
import type { EditionRow, WorkRow } from '../db/schema';
import { isbnFromIdentifiers } from '../isbn/lookup';
import { rowIdentifiers } from '../edition-record';
import type { Contributor } from '../book-wire';
import { workRecordValue, type WorkRecordSource } from '../book-records';
import { wireContributorsFor } from './wire-contributors';

export { isbnFromIdentifiers };

type Db = DbExecutor;

const YEAR_TOLERANCE = 2;
const OL_WORK_PREFIX = '/works/';
const PAGE_SIZE = 100;

/** Size a phase up front so the caller's progress bar is real, not a spinner. */
async function countEditions(db: Db, where: SQL): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)` }).from(editions).where(where);
  return Number(row?.c ?? 0);
}

// Editions whose link was decided by user votes are off limits: an automated
// pass must never silently re-link something people voted to unlink, nor
// re-link a work a consensus unlink removed.
const notConsensusManaged = sql`coalesce(${editions.workLinkSource}, 'auto') <> 'consensus'`;

/**
 * Editions a previous pass already asked OpenLibrary about and found no match
 * for. Skipping them is what makes a re-run cost minutes instead of a day.
 */
const NOT_YET_CHECKED = sql`NOT EXISTS (
  SELECT 1 FROM edition_work_backfill b WHERE b.uri = ${editions.uri}
)`;

export interface BackfillSummary {
  /** Orphan editions the scan visited. */
  orphansFound: number;
  /** Editions linked to a catalog work this pass. */
  linked: number;
  /** Work rows this pass created (a reused work is not counted). */
  created: number;
  /** Orphans with no OpenLibrary match: left with `work_uri` NULL on purpose. */
  unmatched: number;
  /** Still-unlinked editions this pass skipped because an earlier pass checked them. */
  alreadyChecked: number;
  /**
   * Orphans whose lookup never happened (OpenLibrary unavailable), left NULL for
   * a later run. Distinct from `unmatched`: one is a verdict, the other is a
   * miss.
   */
  deferred: number;
  /** Orphans the pass could not even try: no title. */
  skipped: number;
  /** Phase 1 stopped early because OpenLibrary stopped answering. */
  aborted: boolean;
  failed: number;
  cidsChecked: number;
  cidsUpdated: number;
  durationMs: number;
}

export interface BackfillOpts {
  db?: Db;
  openLibrary?: OpenLibrarySource;
  log: Logger;
  pageSize?: number;
  now?: () => Date;
  /**
   * Which slice of the catalog to walk, for running several processes over one
   * large table. Defaults to the whole catalog. See `shardPredicate`.
   */
  shardIndex?: number;
  shardCount?: number;
  /**
   * Ask OpenLibrary again about editions a previous pass marked unmatched.
   * Off by default: the marker exists so a re-run is cheap.
   */
  retryUnmatched?: boolean;
  /**
   * Called once with `done: 0` when a phase starts (so a caller can size its
   * progress bar from the real total), then after each row.
   */
  onProgress?: (phase: 'orphans' | 'cids', done: number, total: number) => void;
}

/**
 * `WHERE` fragment selecting one shard of `editions`, by uri.
 *
 * Deterministic across processes, restarts and Postgres versions (it hashes in
 * SQL with `md5`, not with an internal hash function whose output may change
 * between releases), so each process walks a disjoint slice and a restart
 * resumes the same one. The first digest byte gives 256 buckets; a shard count
 * above that would leave empty shards, so it is rejected.
 */
export function shardPredicate(index: number, count: number): SQL {
  if (!Number.isInteger(count) || count < 1 || count > 256) {
    throw new Error(`shardCount must be an integer between 1 and 256, got ${count}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`shardIndex must be an integer in [0, ${count}), got ${index}`);
  }
  if (count === 1) return sql`true`;
  return sql`mod(get_byte(decode(md5(${editions.uri}), 'hex'), 0), ${count}) = ${index}`;
}

export function editionSearchQuery(edition: Pick<EditionRow, 'title' | 'identifiers'>): string {
  return isbnFromIdentifiers(rowIdentifiers(edition.identifiers)) ?? edition.title;
}

export function normalizeTitle(s: string): string {
  return s.trim().toLowerCase();
}

export function matchWorkCandidate(
  candidates: ReadonlyArray<WorkItem>,
  edition: Pick<EditionRow, 'title' | 'publishedYear'>,
): WorkItem | null {
  const target = normalizeTitle(edition.title);
  const targetYear = edition.publishedYear ?? undefined;
  for (const candidate of candidates) {
    if (normalizeTitle(candidate.title) !== target) continue;
    if (targetYear !== undefined && candidate.firstPublishedYear !== undefined) {
      if (Math.abs(candidate.firstPublishedYear - targetYear) > YEAR_TOLERANCE) continue;
    }
    return candidate;
  }
  return null;
}

export function olKeyFromWorkIdentifiers(idents: ReadonlyArray<Identifier>): string | undefined {
  for (const identifier of idents) {
    if (identifier.type !== 'openlibrary.org') continue;
    if (identifier.url) {
      let url: URL | undefined;
      try { url = new URL(identifier.url); } catch { url = undefined; }
      if (url && url.hostname === 'openlibrary.org' && url.pathname.startsWith(OL_WORK_PREFIX)) return url.pathname;
    }
    if (/^OL\d+W$/.test(identifier.value)) return `${OL_WORK_PREFIX}${identifier.value}`;
  }
  return undefined;
}

export function rkeyForWorkFromOlKey(olKey: string): string {
  const olId = olKey.replace(OL_WORK_PREFIX, '');
  return `ol.W${olId.slice(2)}`;
}

export function workUriForRkey(rkey: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.work/${rkey}`;
}

export function rkeyFromUri(uri: string): string {
  return uri.split('/').pop() ?? '';
}

/**
 * Recompute a work's CID from the value the API serves: the stored columns plus
 * the contributor entries expanded from the row's strongRefs.
 */
export async function recomputeWorkCid(
  row: WorkRecordSource,
  contributors: Contributor[],
): Promise<string> {
  const value = workRecordValue(row, contributors);
  return (await cidForLex(value as unknown as LexMap)).toString();
}

async function upsertWorkRow(
  db: Db,
  workItem: WorkItem,
  uri: string,
  log: Logger,
): Promise<{ row: WorkRow; created: boolean }> {
  const now = new Date();
  const rkey = uri.split('/').pop() ?? 'unknown';
  const contributors = await wireContributorsFor(db, workItem.contributors);
  // Hash the timestamp exactly as the row will store it, so the served value and
  // this CID cannot differ on ISO-string precision.
  const cid = await recomputeWorkCid({ ...workItem, uri, createdAt: new Date(workItem.createdAt) }, contributors);
  // `xmax = 0` is set only on a freshly inserted tuple, so the upsert can say
  // whether this pass added the work or merely refreshed one an earlier pass (or
  // another ingest path) created. That distinction is what `created` reports.
  const [written] = await db.insert(works).values({
    uri,
    cid,
    did: PUBLISHER_DID,
    rkey,
    title: workItem.title,
    subtitle: workItem.subtitle ?? null,
    originalLanguage: workItem.originalLanguage ?? null,
    firstPublishedYear: workItem.firstPublishedYear ?? null,
    subjects: workItem.subjects,
    contributors: workItem.contributors,
    identifiers: workItem.identifiers,
    description: workItem.description ?? null,
    createdAt: new Date(workItem.createdAt),
  }).onConflictDoUpdate({
    target: works.uri,
    set: {
      title: workItem.title,
      subtitle: workItem.subtitle ?? null,
      description: workItem.description ?? null,
      identifiers: workItem.identifiers,
      contributors: workItem.contributors,
      indexedAt: now,
    },
  }).returning({ inserted: sql<boolean>`xmax = 0` });
  const [row] = await db.select().from(works).where(eq(works.uri, uri)).limit(1);
  if (!row) throw new Error(`upsertWorkRow: row missing after upsert (${uri})`);
  log.debug({ stage: 'backfill-works', uri, cid }, 'work upserted');
  return { row, created: written?.inserted === true };
}

async function reconcileOneOrphan(
  edition: EditionRow,
  db: Db,
  openLibrary: OpenLibrarySource,
  log: Logger,
  now: () => Date,
  summary: BackfillSummary,
): Promise<void> {
  const q = editionSearchQuery(edition);
  const editionTitleLen = edition.title.trim().length;
  if (editionTitleLen === 0) {
    log.warn({ stage: 'backfill-works', editionUri: edition.uri }, 'orphan edition has no title; skipped');
    summary.skipped++;
    return;
  }
  const olResult = await openLibrary.searchWorks({ q, limit: 5 });
  if (olResult.degraded) {
    // No answer, so no verdict: the row stays NULL and a later run asks again.
    // Recording it as unmatched would make an outage look like a catalog fact.
    log.warn({ stage: 'backfill-works', editionUri: edition.uri, reason: olResult.degraded.reason }, 'openlibrary unavailable; row deferred');
    summary.deferred++;
    return;
  }
  const match = olResult.items.length > 0 ? matchWorkCandidate(olResult.items, edition) : null;
  const olKey = match ? olKeyFromWorkIdentifiers(match.identifiers) : undefined;
  if (!match || !olKey) {
    // The catalog does not know this work. Leaving `work_uri` NULL is the
    // honest answer: a work invented from the edition's own fields would carry
    // no subjects and no contributors, so it would sit in the catalog explaining
    // nothing — and nothing reads a NULL here except the recommendation join,
    // which has no genre signal to work with anyway.
    log.info(
      { stage: 'backfill-works', outcome: 'unmatched', editionUri: edition.uri, candidates: olResult.items.length },
      'orphan unmatched; left unlinked',
    );
    summary.unmatched++;
    const reason = olResult.items.length > 0 ? 'title_mismatch' : 'no_candidate';
    await db
      .insert(editionWorkBackfill)
      .values({ uri: edition.uri, status: 'unmatched', reason, checkedAt: new Date() })
      .onConflictDoUpdate({
        target: editionWorkBackfill.uri,
        set: { status: 'unmatched', reason, checkedAt: new Date() },
      });
    return;
  }
  const workItem = match;
  const rkey = rkeyForWorkFromOlKey(olKey);
  const uri = workUriForRkey(rkey);
  const { row, created } = await upsertWorkRow(db, workItem, uri, log);
  const updated = await db.update(editions)
    .set({ workUri: uri, workCid: row.cid, workLinkSource: 'auto' })
    .where(and(eq(editions.uri, edition.uri), isNull(editions.workUri), notConsensusManaged))
    .returning({ uri: editions.uri });
  if (updated.length === 0) {
    log.debug({ stage: 'backfill-works', editionUri: edition.uri }, 'orphan already linked by concurrent run; skipped');
    summary.skipped++;
    return;
  }
  if (created) summary.created++;
  summary.linked++;
  // A link supersedes an earlier "no match": if this edition is unlinked again,
  // the next run must be free to look it up.
  await db.delete(editionWorkBackfill).where(eq(editionWorkBackfill.uri, edition.uri));
  log.info({
    stage: 'backfill-works',
    outcome: created ? 'created-from-ol' : 'reused',
    editionUri: edition.uri,
    workUri: uri,
    workCid: row.cid,
  }, 'orphan reconciled');
}

async function reverifyOneEdition(
  edition: EditionRow,
  db: Db,
  log: Logger,
  summary: BackfillSummary,
): Promise<void> {
  if (!edition.workUri) return;
  const [workRow] = await db.select().from(works).where(eq(works.uri, edition.workUri)).limit(1);
  if (!workRow) {
    log.warn({ stage: 'backfill-works', editionUri: edition.uri, workUri: edition.workUri }, 'linked work row missing; skipping CID check');
    return;
  }
  summary.cidsChecked++;
  const contributors = await wireContributorsFor(db, workRow.contributors);
  const recomputed = await recomputeWorkCid(workRow, contributors);
  if (recomputed === workRow.cid) return;
  await db.update(works).set({ cid: recomputed }).where(eq(works.uri, workRow.uri));
  // Keep the edition's work_cid in sync so getRecord responses match too.
  await db.update(editions)
    .set({ workCid: recomputed })
    .where(eq(editions.uri, edition.uri));
  summary.cidsUpdated++;
  log.info({
    stage: 'backfill-works',
    outcome: 'cid-updated',
    editionUri: edition.uri,
    workUri: workRow.uri,
    oldCid: workRow.cid,
    newCid: recomputed,
  }, 'work CID drift fixed');
}

export async function runBackfill(opts: BackfillOpts): Promise<BackfillSummary> {
  const startedAt = Date.now();
  const db = opts.db ?? defaultDb;
  const log = opts.log;
  const openLibrary = opts.openLibrary ?? new OpenLibrarySource(log);
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const now = opts.now ?? (() => new Date());
  const shardCount = opts.shardCount ?? 1;
  const shard = shardPredicate(opts.shardIndex ?? 0, shardCount);
  /** Stop phase 1 after this many rows in a row were never looked up. */
  const MAX_CONSECUTIVE_DEFERRED = 25;
  let consecutiveDeferred = 0;
  let aborted = false;

  const summary: BackfillSummary = {
    orphansFound: 0,
    linked: 0,
    created: 0,
    unmatched: 0,
    alreadyChecked: 0,
    deferred: 0,
    skipped: 0,
    aborted: false,
    failed: 0,
    cidsChecked: 0,
    cidsUpdated: 0,
    durationMs: 0,
  };

  // Only counted when someone is listening: the scan otherwise keeps exactly
  // one query per page (which its callers' harnesses assume).
  // A re-run skips what an earlier pass already answered. `retryUnmatched`
  // throws that away and asks OpenLibrary about every orphan again.
  const checkFilter = opts.retryUnmatched ? sql`true` : NOT_YET_CHECKED;
  let orphanTotal = 0;
  if (opts.onProgress) {
    orphanTotal = await countEditions(db, and(isNull(editions.workUri), notConsensusManaged, shard, checkFilter)!);
    // Rows an earlier pass already answered for: a scan that finishes in
    // minutes is only good news if it skipped something.
    const [marked] = await db
      .select({ c: sql<number>`count(*)` })
      .from(editions)
      .where(and(isNull(editions.workUri), notConsensusManaged, shard, sql`NOT (${NOT_YET_CHECKED})`));
    summary.alreadyChecked = Number(marked?.c ?? 0);
    opts.onProgress('orphans', 0, orphanTotal);
  }
  log.info(
    { stage: 'backfill-works', pageSize, shardIndex: opts.shardIndex ?? 0, shardCount },
    'phase 1: reconcile orphans',
  );
  let cursor: string | null = null;
  for (;;) {
    const conds: ReturnType<typeof sql>[] = [isNull(editions.workUri), notConsensusManaged, shard, checkFilter];
    if (cursor) conds.push(sql`${editions.uri} > ${cursor}`);
    const where = and(...conds);
    const rows: EditionRow[] = await db.select().from(editions)
      .where(where)
      .orderBy(asc(editions.uri))
      .limit(pageSize);
    if (rows.length === 0) break;
    for (const edition of rows) {
      cursor = edition.uri;
      summary.orphansFound++;
      const deferredBefore = summary.deferred;
      try {
        await reconcileOneOrphan(edition, db, openLibrary, log, now, summary);
      } catch (err) {
        log.error({ stage: 'backfill-works', err, editionUri: edition.uri }, 'reconcile failed');
        summary.failed++;
      }
      // An unavailable catalog is not a fact about these editions. Stop once it
      // is clearly down: grinding through 240k rows that were never looked up
      // would fill the journal and sum to nothing.
      consecutiveDeferred = summary.deferred > deferredBefore ? consecutiveDeferred + 1 : 0;
      if (consecutiveDeferred >= MAX_CONSECUTIVE_DEFERRED) {
        aborted = true;
        summary.aborted = true;
        log.error(
          { stage: 'backfill-works', consecutiveDeferred, deferred: summary.deferred },
          'openlibrary unavailable; aborting phase 1',
        );
        break;
      }
      opts.onProgress?.('orphans', summary.orphansFound, orphanTotal);
    }
    if (aborted) break;
  }

  log.info(
    { stage: 'backfill-works', shardIndex: opts.shardIndex ?? 0, shardCount },
    'phase 2: re-verify work CIDs',
  );
  cursor = null;
  let cidTotal = 0;
  if (opts.onProgress) {
    cidTotal = await countEditions(db, and(isNotNull(editions.workUri), shard)!);
    opts.onProgress('cids', 0, cidTotal);
  }
  for (;;) {
    const conds: ReturnType<typeof sql>[] = [isNotNull(editions.workUri), shard];
    if (cursor) conds.push(sql`${editions.uri} > ${cursor}`);
    const where = and(...conds);
    const rows: EditionRow[] = await db.select().from(editions)
      .where(where)
      .orderBy(asc(editions.uri))
      .limit(pageSize);
    if (rows.length === 0) break;
    for (const edition of rows) {
      cursor = edition.uri;
      try {
        await reverifyOneEdition(edition, db, log, summary);
      } catch (err) {
        log.error({ stage: 'backfill-works', err, editionUri: edition.uri }, 'CID re-verify failed');
        summary.failed++;
      }
      opts.onProgress?.('cids', summary.cidsChecked, cidTotal);
    }
  }

  summary.durationMs = Date.now() - startedAt;
  log.info({ stage: 'backfill-works', ...summary }, 'backfill done');
  return summary;
}