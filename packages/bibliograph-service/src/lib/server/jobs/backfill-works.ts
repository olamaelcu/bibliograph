// Backfill works for editions with no `work_uri`.
//
// Two phases:
//
//   Phase 1 — orphans (editions.work_uri IS NULL):
//     No upstream can answer "which work is this edition", so every orphan the
//     scan visits is deferred: the row keeps `work_uri` NULL, one warning is
//     logged per row, and a later run looks at it again.
//
//     A row is deliberately never marked `unmatched`. With no catalogue to
//     consult, that verdict would turn the absence of a provider into a fact
//     about the catalog, and a work invented from the edition's own fields
//     would carry no subjects and no contributors — a catalog row that
//     explains nothing. `editions.work_uri` is an AppView-internal join key
//     (the served edition record does not carry `work`), so NULL is the honest
//     value for "the catalog does not know this work".
//
//     The scan stops after 25 consecutive deferrals: walking a whole catalog
//     nobody could look at only fills the journal.
//
//   Phase 2 — CID re-verify (editions.work_uri IS NOT NULL):
//     For each already-linked edition, load the work row, recompute its CID
//     from the column values and the contributor records they reference via
//     `cidForLex`, and persist if the recomputed CID differs from the stored
//     one. No-op when equal; safe to re-run.
//
// Re-runs are idempotent: Phase 1's `WHERE work_uri IS NULL` predicate means
// already-reconciled editions are skipped, and Phase 2 only writes when the
// CID actually drifts. Orphans an earlier pass already judged are skipped via
// their `edition_work_backfill` marker unless `retryUnmatched` is set; this pass
// never writes one.
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
import { editions, works } from '../db/schema';
import type { DbExecutor } from '../stats';
import type { EditionRow } from '../db/schema';
import type { Contributor } from '../book-wire';
import { workRecordValue, type WorkRecordSource } from '../book-records';
import { wireContributorsFor } from './wire-contributors';

type Db = DbExecutor;

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
 * Editions a previous pass already answered for. The markers date from when a
 * work catalogue could be consulted; skipping them is what makes a re-run
 * cheap, and `retryUnmatched` opts back in.
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
  /** Orphans a pass decided had no matching work. Phase 1 no longer decides this. */
  unmatched: number;
  /** Still-unlinked editions this pass skipped because an earlier pass checked them. */
  alreadyChecked: number;
  /**
   * Orphans left NULL for a later run because nothing could look them up. This
   * is every orphan phase 1 visits now: no work source exists.
   */
  deferred: number;
  /** Orphans the pass could not even try (no title). Phase 1 no longer skips any. */
  skipped: number;
  /** Phase 1 stopped early: nothing could answer for a run of rows. */
  aborted: boolean;
  failed: number;
  cidsChecked: number;
  cidsUpdated: number;
  durationMs: number;
}

export interface BackfillOpts {
  db?: Db;
  log: Logger;
  pageSize?: number;
  /**
   * Which slice of the catalog to walk, for running several processes over one
   * large table. Defaults to the whole catalog. See `shardPredicate`.
   */
  shardIndex?: number;
  shardCount?: number;
  /**
   * Visit editions a previous pass marked unmatched instead of skipping them.
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

function reconcileOneOrphan(
  edition: EditionRow,
  log: Logger,
  summary: BackfillSummary,
): void {
  // Nothing can answer "which work is this edition", so there is no verdict to
  // record: the row keeps `work_uri` NULL and a later run looks at it again.
  // Writing `unmatched` (and its permanent marker) would turn the absence of a
  // provider into a fact about the catalog and keep the row out of every future
  // pass; inventing a work here would put a subject-less, contributor-less row
  // into the catalog instead.
  log.warn({ stage: 'backfill-works', editionUri: edition.uri }, 'no work source available; row deferred');
  summary.deferred++;
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
  const pageSize = opts.pageSize ?? PAGE_SIZE;
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
  // throws that away and visits every orphan again.
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
    'phase 1: scan orphans',
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
        reconcileOneOrphan(edition, log, summary);
      } catch (err) {
        log.error({ stage: 'backfill-works', err, editionUri: edition.uri }, 'reconcile failed');
        summary.failed++;
      }
      // Nothing can answer for any of these rows. Stop once that is clear:
      // grinding through 240k rows nobody looked at would fill the journal and
      // sum to nothing.
      consecutiveDeferred = summary.deferred > deferredBefore ? consecutiveDeferred + 1 : 0;
      if (consecutiveDeferred >= MAX_CONSECUTIVE_DEFERRED) {
        aborted = true;
        summary.aborted = true;
        log.error(
          { stage: 'backfill-works', consecutiveDeferred, deferred: summary.deferred },
          'no work source; aborting phase 1',
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