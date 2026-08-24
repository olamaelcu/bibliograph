// Backfill works for editions with no `work_uri`.
//
// Two phases, both always on:
//
//   Phase 1 — orphans (editions.work_uri IS NULL):
//     For each orphan: derive a search key from identifiers (ISBN preferred)
//     or title, query OpenLibrary's work search, pick the first candidate
//     whose title matches case-insensitively AND whose `first_publish_year`
//     is within ±2 years (or missing on both sides). If no candidate matches,
//     synthesize a work record from the edition's own fields. Ingest the
//     resulting WorkItem (idempotent upsert keyed by deterministic URI),
//     then write `editions.work_uri` / `work_cid` for the now-linked pair.
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
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { editions, works } from '../db/schema';
import type { DbExecutor } from '../stats';
import { PUBLISHER_DID } from '../did';
import { OpenLibrarySource } from '../search/open-library-source';
import type { WorkItem, Identifier } from '../search/types';
import type { EditionRow, WorkRow } from '../db/schema';

type Db = DbExecutor;

const YEAR_TOLERANCE = 2;
const OL_WORK_PREFIX = '/works/';
const PAGE_SIZE = 100;

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
  openLibrary?: OpenLibrarySource;
  log: Logger;
  pageSize?: number;
  now?: () => Date;
}

export function isbnFromIdentifiers(idents: ReadonlyArray<Identifier>): string | undefined {
  for (const ident of idents) {
    if (ident.resource === 'isbn13' || ident.resource === 'isbn10' || ident.resource === 'isbn') {
      return ident.uri.replace(/^isbn:/, '');
    }
  }
  return undefined;
}

export function editionSearchQuery(edition: Pick<EditionRow, 'title' | 'identifiers'>): string {
  return isbnFromIdentifiers(edition.identifiers) ?? edition.title;
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
  for (const ident of idents) {
    if (ident.resource === 'openlibrary') {
      let u: URL;
      try { u = new URL(ident.uri); } catch { continue; }
      if (u.hostname === 'openlibrary.org' && u.pathname.startsWith(OL_WORK_PREFIX)) return u.pathname;
    }
  }
  return undefined;
}

export function rkeyForWorkFromOlKey(olKey: string): string {
  return `ol-work-${olKey.replace(OL_WORK_PREFIX, '')}`;
}

export function rkeyForSyntheticWork(editionUri: string): string {
  // `synth-work-<editionRkey>` — distinct namespace from `ol-work-*`, so a
  // later OL discovery never overwrites a synthetic record.
  const tail = editionUri.split('/').pop() ?? 'unknown';
  return `synth-work-${tail}`;
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
    const suffix = editionRkey.slice(3);
    return `ol.W${suffix}`;
  }
  return `ol.W${editionRkey}`;
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
  const match = olResult.items.length > 0 ? matchWorkCandidate(olResult.items, edition) : null;
  let workItem: WorkItem;
  let rkey: string;
  let outcome: 'reused' | 'created-from-ol' | 'synthesized';
  if (match) {
    const olKey = olKeyFromWorkIdentifiers(match.identifiers);
    if (olKey) {
      rkey = rkeyForWorkFromOlKey(olKey);
      workItem = match;
      outcome = 'created-from-ol';
    } else {
      // Defensive: matched but OL key missing → fall through to synthesized.
      workItem = synthesizeWorkFromEdition(edition, now());
      rkey = rkeyForSyntheticWork(edition.uri);
      outcome = 'synthesized';
    }
  } else if (olResult.items.length > 0) {
    // OL returned items but none matched (year drift, etc.). Synthesize so the
    // orphan gets resolved; the synthetic rkey avoids colliding with future OL
    // matches.
    workItem = synthesizeWorkFromEdition(edition, now());
    rkey = rkeyForSyntheticWork(edition.uri);
    outcome = 'synthesized';
  } else {
    workItem = synthesizeWorkFromEdition(edition, now());
    rkey = rkeyForSyntheticWork(edition.uri);
    outcome = 'synthesized';
  }
  const uri = workUriForRkey(rkey);
  const row = await upsertWorkRow(db, workItem, uri, log);
  const updated = await db.update(editions)
    .set({ workUri: uri, workCid: row.cid })
    .where(and(eq(editions.uri, edition.uri), isNull(editions.workUri)))
    .returning({ uri: editions.uri });
  if (updated.length === 0) {
    log.debug({ stage: 'backfill-works', editionUri: edition.uri }, 'orphan already linked by concurrent run; skipped');
    summary.skipped++;
    return;
  }
  if (outcome === 'synthesized' || outcome === 'created-from-ol') summary.created++;
  summary.linked++;
  log.info({
    stage: 'backfill-works',
    outcome,
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
  const openLibrary = opts.openLibrary ?? new OpenLibrarySource(log);
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

  log.info({ stage: 'backfill-works', pageSize }, 'phase 1: reconcile orphans');
  let cursor: string | null = null;
  for (;;) {
    const conds: ReturnType<typeof sql>[] = [isNull(editions.workUri)];
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
        await reconcileOneOrphan(edition, db, openLibrary, log, now, summary);
      } catch (err) {
        log.error({ stage: 'backfill-works', err, editionUri: edition.uri }, 'reconcile failed');
        summary.failed++;
      }
    }
  }

  log.info({ stage: 'backfill-works' }, 'phase 2: re-verify work CIDs');
  cursor = null;
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
    }
  }

  summary.durationMs = Date.now() - startedAt;
  log.info({ stage: 'backfill-works', ...summary }, 'backfill done');
  return summary;
}