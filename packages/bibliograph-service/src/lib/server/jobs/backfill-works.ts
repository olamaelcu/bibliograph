// Backfill works for editions with no `work_uri`.
//
// Two phases, both always on:
//
//   Phase 1 — orphans (editions.work_uri IS NULL):
//     For each orphan: synthesize a work record from the edition's own fields.
//     Ingest the resulting WorkItem (idempotent upsert keyed by deterministic
//     URI), then write `editions.work_uri` / `work_cid` for the now-linked
//     pair.
//
//   Phase 2 — CID re-verify (editions.work_uri IS NOT NULL):
//     For each already-linked edition, load the work row, recompute its CID
//     from the column values via `cidForLex`, and persist if the recomputed
//     CID differs from the stored one. No-op when equal; safe to re-run.
//
// Re-runs are idempotent: Phase 1's `WHERE work_uri IS NULL` predicate means
// already-reconciled editions are skipped, and Phase 2 only writes when the
// CID actually drifts.

import type { Logger } from 'pino';
import type { SQL } from 'drizzle-orm';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { editions, works } from '../db/schema';
import type { DbExecutor } from '../stats';
import { PUBLISHER_DID } from '../did';
import type { WorkItem } from '../search/types';
import type { EditionRow, WorkRow } from '../db/schema';

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

export interface BackfillSummary {
  orphansFound: number;
  linked: number;
  created: number;
  skipped: number;
  failed: number;
  cidsChecked: number;
  cidsUpdated: number;
  durationMs: number;
}

export interface BackfillOpts {
  db?: Db;
  log: Logger;
  pageSize?: number;
  now?: () => Date;
  /**
   * Called once with `done: 0` when a phase starts (so a caller can size its
   * progress bar from the real total), then after each row.
   */
  onProgress?: (phase: 'orphans' | 'cids', done: number, total: number) => void;
}

export function rkeyForSyntheticWork(editionUri: string): string {
  const tail = editionUri.split('/').pop() ?? 'unknown';
  if (tail.startsWith('ol.')) {
    return `${tail}S`;
  }
  return `ol.${tail}S`;
}

export function workUriForRkey(rkey: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.work/${rkey}`;
}

export function rkeyFromUri(uri: string): string {
  return uri.split('/').pop() ?? '';
}

export function workRkeyFromEditionUri(editionUri: string): string {
  const editionRkey = rkeyFromUri(editionUri);
  if (editionRkey.startsWith('ol.')) {
    const olId = editionRkey.slice(3);
    return `ol.W${olId.slice(2)}`;
  }
  const olId = editionRkey.replace(/^OL/, '');
  return `ol.W${olId}`;
}

export function synthesizeWorkFromEdition(edition: EditionRow, now: Date = new Date()): WorkItem {
  return {
    uri: workUriForRkey(workRkeyFromEditionUri(edition.uri)),
    title: edition.title,
    subtitle: edition.subtitle ?? undefined,
    originalLanguage: edition.language ?? undefined,
    firstPublishedYear: edition.publishedYear ?? undefined,
    subjects: [],
    description: edition.description ?? undefined,
    contributors: [],
    identifiers: [{
      uri: `${edition.uri}#work`,
      resource: 'synthesized',
    }],
    createdAt: now.toISOString(),
  };
}

export function workValueForCid(row: WorkRow): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.work' as const,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    originalLanguage: row.originalLanguage ?? undefined,
    firstPublishedYear: row.firstPublishedYear ?? undefined,
    subjects: row.subjects,
    contributors: row.contributors,
    identifiers: row.identifiers,
    description: row.description ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function recomputeWorkCid(row: WorkRow): Promise<string> {
  const value = workValueForCid(row);
  return (await cidForLex(value as unknown as LexMap)).toString();
}

async function upsertWorkRow(
  db: Db,
  workItem: WorkItem,
  uri: string,
  log: Logger,
): Promise<WorkRow> {
  const now = new Date();
  const value = {
    $type: 'community.lexicon.book.work' as const,
    title: workItem.title,
    subtitle: workItem.subtitle ?? undefined,
    originalLanguage: workItem.originalLanguage ?? undefined,
    firstPublishedYear: workItem.firstPublishedYear ?? undefined,
    subjects: workItem.subjects,
    contributors: workItem.contributors,
    identifiers: workItem.identifiers,
    description: workItem.description ?? undefined,
    createdAt: workItem.createdAt,
  };
  const cid = (await cidForLex(value as unknown as LexMap)).toString();
  const rkey = uri.split('/').pop() ?? 'unknown';
  await db.insert(works).values({
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
  });
  const [row] = await db.select().from(works).where(eq(works.uri, uri)).limit(1);
  if (!row) throw new Error(`upsertWorkRow: row missing after upsert (${uri})`);
  log.debug({ stage: 'backfill-works', uri, cid }, 'work upserted');
  return row;
}

async function reconcileOneOrphan(
  edition: EditionRow,
  db: Db,
  log: Logger,
  now: () => Date,
  summary: BackfillSummary,
): Promise<void> {
  const editionTitleLen = edition.title.trim().length;
  if (editionTitleLen === 0) {
    log.warn({ stage: 'backfill-works', editionUri: edition.uri }, 'orphan edition has no title; skipped');
    summary.skipped++;
    return;
  }
  const workItem: WorkItem = synthesizeWorkFromEdition(edition, now());
  const rkey = rkeyForSyntheticWork(edition.uri);
  const uri = workUriForRkey(rkey);
  const row = await upsertWorkRow(db, workItem, uri, log);
  const updated = await db.update(editions)
    .set({ workUri: uri, workCid: row.cid, workLinkSource: 'auto' })
    .where(and(eq(editions.uri, edition.uri), isNull(editions.workUri), notConsensusManaged))
    .returning({ uri: editions.uri });
  if (updated.length === 0) {
    log.debug({ stage: 'backfill-works', editionUri: edition.uri }, 'orphan already linked by concurrent run; skipped');
    summary.skipped++;
    return;
  }
  summary.created++;
  summary.linked++;
  log.info({
    stage: 'backfill-works',
    outcome: 'synthesized',
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
  const recomputed = await recomputeWorkCid(workRow);
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
  const now = opts.now ?? (() => new Date());

  const summary: BackfillSummary = {
    orphansFound: 0,
    linked: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    cidsChecked: 0,
    cidsUpdated: 0,
    durationMs: 0,
  };

  // Only counted when someone is listening: the scan otherwise keeps exactly
  // one query per page (which its callers' harnesses assume).
  let orphanTotal = 0;
  if (opts.onProgress) {
    orphanTotal = await countEditions(db, and(isNull(editions.workUri), notConsensusManaged)!);
    opts.onProgress('orphans', 0, orphanTotal);
  }
  log.info({ stage: 'backfill-works', pageSize }, 'phase 1: reconcile orphans');
  let cursor: string | null = null;
  for (;;) {
    const conds: ReturnType<typeof sql>[] = [isNull(editions.workUri), notConsensusManaged];
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
      try {
        await reconcileOneOrphan(edition, db, log, now, summary);
      } catch (err) {
        log.error({ stage: 'backfill-works', err, editionUri: edition.uri }, 'reconcile failed');
        summary.failed++;
      }
      opts.onProgress?.('orphans', summary.orphansFound, orphanTotal);
    }
  }

  log.info({ stage: 'backfill-works' }, 'phase 2: re-verify work CIDs');
  cursor = null;
  let cidTotal = 0;
  if (opts.onProgress) {
    cidTotal = await countEditions(db, and(isNotNull(editions.workUri))!);
    opts.onProgress('cids', 0, cidTotal);
  }
  for (;;) {
    const conds: ReturnType<typeof sql>[] = [isNotNull(editions.workUri)];
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