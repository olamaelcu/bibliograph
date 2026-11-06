import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import {
  recomputeWorkCid,
  rkeyForSyntheticWork,
  runBackfill,
  synthesizeWorkFromEdition,
  workUriForRkey,
  workValueForCid,
} from './backfill-works';
import type { EditionRow, WorkRow } from '../db/schema';
import { PUBLISHER_DID } from '../did';

const silentLog = pino({ level: 'silent' });

function makeEditionRow(overrides: Partial<EditionRow> = {}): EditionRow {
  // Merge `overrides` with Object.assign instead of spreading them into the
  // literal: spreading a `Partial<T>` re-widens every column to `| undefined`,
  // which the row type does not allow. Object.assign intersects them back.
  const base: EditionRow = {
    uri: 'at://did:plc:user/community.lexicon.book.edition/rec1',
    cid: 'bafye1',
    did: 'did:plc:user',
    rkey: 'rec1',
    tid: '3mzktest00001',
    title: 'Test Edition',
    subtitle: null,
    workUri: null,
    workCid: null,
    workLinkSource: null,
    publisherUri: null,
    publisherCid: null,
    place: null,
    publishedYear: 2024,
    language: null,
    contributors: [],
    identifiers: [],
    description: null,
    coverImageUrl: null,
    format: null,
    pages: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    descriptionCheckedAt: null,
  };
  return Object.assign(base, overrides);
}

function makeWorkRow(overrides: Partial<WorkRow> = {}): WorkRow {
  // Merge `overrides` with Object.assign instead of spreading them into the
  // literal: spreading a `Partial<T>` re-widens every column to `| undefined`,
  // which the row type does not allow. Object.assign intersects them back.
  const base: WorkRow = {
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/ol-work-OL1W',
    cid: 'bafyw1',
    did: PUBLISHER_DID,
    rkey: 'ol-work-OL1W',
    title: 'Test Edition',
    subtitle: null,
    originalLanguage: null,
    firstPublishedYear: 2024,
    subjects: [],
    contributors: [],
    identifiers: [{ uri: 'https://www.wikidata.org/entity/Q1', resource: 'wikidata' }],
    description: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    descriptionCheckedAt: null,
  };
  return Object.assign(base, overrides);
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

test('rkeyForSyntheticWork derives a stable rkey from the edition URI', () => {
  const uri = 'at://did:plc:user/community.lexicon.book.edition/gb.b9AOEAAAQBAJ';
  assert.equal(rkeyForSyntheticWork(uri), 'ol.gb.b9AOEAAAQBAJS');
  assert.equal(
    rkeyForSyntheticWork('at://did:plc:user/community.lexicon.book.edition/some-other'),
    'ol.some-otherS',
  );
});

test('workUriForRkey uses PUBLISHER_DID', () => {
  assert.equal(
    workUriForRkey('ol.W66554W'),
    `at://${PUBLISHER_DID}/community.lexicon.book.work/ol.W66554W`,
  );
});

test('synthesizeWorkFromEdition maps edition fields to WorkItem', () => {
  const edition = makeEditionRow({
    title: 'X',
    subtitle: 'Y',
    language: 'en',
    publishedYear: 1999,
    description: 'A book.',
  });
  const now = new Date('2025-01-01T00:00:00Z');
  const work = synthesizeWorkFromEdition(edition, now);
  assert.equal(work.title, 'X');
  assert.equal(work.subtitle, 'Y');
  assert.equal(work.originalLanguage, 'en');
  assert.equal(work.firstPublishedYear, 1999);
  assert.equal(work.description, 'A book.');
  assert.deepEqual(work.subjects, []);
  assert.equal(work.contributors.length, 0);
  assert.equal(work.createdAt, '2025-01-01T00:00:00.000Z');
  assert.equal(work.identifiers.length, 1);
  assert.equal(work.identifiers[0]?.resource, 'synthesized');
});

// ─── CID recompute ────────────────────────────────────────────────────────

test('workValueForCid round-trips all stored columns', () => {
  const row = makeWorkRow({
    title: 'Round Trip',
    subtitle: 'Sub',
    originalLanguage: 'fr',
    firstPublishedYear: 1850,
    subjects: ['fiction'],
    contributors: [{ subject: { uri: 'at://x', cid: 'c' }, role: 'author' }],
    description: 'desc',
  });
  const value = workValueForCid(row);
  assert.equal(value.title, 'Round Trip');
  assert.equal(value.subtitle, 'Sub');
  assert.equal(value.originalLanguage, 'fr');
  assert.equal(value.firstPublishedYear, 1850);
  assert.deepEqual(value.subjects, ['fiction']);
  assert.equal(value.description, 'desc');
  assert.equal(value.$type, 'community.lexicon.book.work');
});

test('recomputeWorkCid produces a deterministic CID for the same row data', async () => {
  const row = makeWorkRow();
  const cid1 = await recomputeWorkCid(row);
  const cid2 = await recomputeWorkCid(row);
  assert.equal(cid1, cid2);
  assert.match(cid1, /^bafy/);
});

test('recomputeWorkCid produces a different CID when row data changes', async () => {
  const a = makeWorkRow();
  const b = makeWorkRow({ title: 'Different Title' });
  const cidA = await recomputeWorkCid(a);
  const cidB = await recomputeWorkCid(b);
  assert.notEqual(cidA, cidB);
});

// ─── runBackfill integration (fake db) ───────────────────────────────────

const DRIZZLE_NAME = Symbol.for('drizzle:Name');

interface CallCapture {
  whereValues: unknown[];
  rows: unknown[][];
  updateCalls: number;
  insertCalls: number;
}

interface FakeChain {
  select: () => FakeChain;
  from: (table: unknown) => FakeChain;
  where: (where?: unknown) => FakeChain;
  orderBy: (...args: unknown[]) => FakeChain;
  limit: (...args: unknown[]) => FakeChain;
  set: (...args: unknown[]) => FakeChain;
  values: (...args: unknown[]) => FakeChain;
  onConflictDoUpdate: (...args: unknown[]) => FakeChain;
  returning: (...args: unknown[]) => FakeChain;
  then: <TResult1 = unknown, TResult2 = unknown>(
    onFulfilled?: ((v: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((e: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
}

function makeThenable(rows: unknown[], capture: CallCapture): FakeChain['then'] {
  return (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected);
}

function makeSelectBuilder(capture: CallCapture): FakeChain {
  let activeTable: 'editions' | 'works' | null = null;
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.from = (table: unknown) => {
    activeTable = ((table as Record<symbol, unknown>)[DRIZZLE_NAME] as 'editions' | 'works') ?? null;
    return builder;
  };
  builder.where = () => builder;
  builder.orderBy = () => builder;
  builder.limit = () => builder;
  builder.then = makeThenable(capture.rows.shift() ?? [], capture);
  // Stash the active table so the `then` impl can branch if needed; capture
  // is intentionally not consulted here.
  void activeTable;
  return builder as unknown as FakeChain;
}

function makeUpdateBuilder(capture: CallCapture): FakeChain {
  const builder: Record<string, unknown> = {};
  builder.set = () => builder;
  builder.where = () => builder;
  builder.returning = () => builder;
  builder.then = (onFulfilled?: ((v: unknown) => unknown) | null, onRejected?: ((e: unknown) => unknown) | null) => {
    capture.updateCalls++;
    return Promise.resolve([{ uri: 'at://updated' }] as unknown[]).then(onFulfilled, onRejected);
  };
  return builder as unknown as FakeChain;
}

function makeInsertBuilder(capture: CallCapture): FakeChain {
  const builder: Record<string, unknown> = {};
  builder.values = () => builder;
  builder.onConflictDoUpdate = () => builder;
  builder.then = (onFulfilled?: ((v: unknown) => unknown) | null, onRejected?: ((e: unknown) => unknown) | null) => {
    capture.insertCalls++;
    return Promise.resolve(undefined).then(onFulfilled, onRejected);
  };
  return builder as unknown as FakeChain;
}

function createFakeDb(_opts: {
  editions: EditionRow[];
  works: Map<string, WorkRow>;
}): { db: unknown; capture: CallCapture } {
  const capture: CallCapture = { whereValues: [], rows: [], updateCalls: 0, insertCalls: 0 };
  const dbProxy = {
    select: () => makeSelectBuilder(capture),
    update: () => makeUpdateBuilder(capture),
    insert: () => makeInsertBuilder(capture),
  };
  return { db: dbProxy, capture };
}

test('runBackfill Phase 1 synthesizes a work for an orphan edition and links it', async () => {
  const edition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/orphan-1',
    rkey: 'orphan-1',
    title: 'Some Book',
    identifiers: [{ uri: 'isbn:9780123456789', resource: 'isbn13' }],
    publishedYear: 2020,
  });
  const workRow = makeWorkRow({
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/ol.orphan-1S',
    rkey: 'ol.orphan-1S',
    title: 'Some Book',
    firstPublishedYear: 2020,
  });
  const { db, capture } = createFakeDb({ editions: [edition], works: new Map([[workRow.uri, workRow]]) });
  // Queue order: phase-1 iter 1, work-row read-back inside reconcile, phase-1 iter 2,
  // phase-2 iter 1, phase-2 iter 2 (defensive — backfill may issue up to 5 selects).
  capture.rows.push(
    [edition],     // phase-1 first select
    [workRow],     // upsertWorkRow read-back
    [],            // phase-1 second select (after cursor advance)
    [],            // phase-2 first select
    [],            // phase-2 second select
  );
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], log: silentLog });
  assert.equal(summary.orphansFound, 1);
  assert.equal(summary.linked, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.cidsChecked, 0, 'no linked editions in phase 2');
});

test('runBackfill Phase 1 skips edition with empty title', async () => {
  const edition = makeEditionRow({ title: '   ', identifiers: [] });
  const { db, capture } = createFakeDb({ editions: [edition], works: new Map() });
  capture.rows.push([edition], [], []);
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], log: silentLog });
  assert.equal(summary.orphansFound, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.linked, 0);
});

test('runBackfill Phase 2 re-verifies CIDs and counts updates', async () => {
  const linkedEdition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/linked-1',
    rkey: 'linked-1',
    workUri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/gb.zyTCAlFPjgYC',
    workCid: 'bafystale', // stale; will be recomputed and updated
  });
  const workRow = makeWorkRow({
    uri: linkedEdition.workUri!,
    cid: 'bafystale',
    title: 'Some Book',
  });
  const { db, capture } = createFakeDb({ editions: [linkedEdition], works: new Map([[workRow.uri, workRow]]) });
  capture.rows.push([], [linkedEdition], [workRow], []);
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], log: silentLog });
  assert.equal(summary.orphansFound, 0);
  assert.equal(summary.cidsChecked, 1);
  assert.equal(summary.cidsUpdated, 1);
});

test('runBackfill Phase 2 is a no-op when CID already matches', async () => {
  const linkedEdition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/linked-2',
    rkey: 'linked-2',
    workUri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/gb.GhPSEAAAQBAJ',
  });
  const freshCid = await recomputeWorkCid(makeWorkRow({ uri: linkedEdition.workUri! }));
  const workRow = makeWorkRow({ uri: linkedEdition.workUri!, cid: freshCid });
  const { db, capture } = createFakeDb({ editions: [linkedEdition], works: new Map([[workRow.uri, workRow]]) });
  capture.rows.push([], [linkedEdition], [workRow], []);
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], log: silentLog });
  assert.equal(summary.cidsChecked, 1);
  assert.equal(summary.cidsUpdated, 0);
});

test('runBackfill second pass is a no-op when Phase 1 has no orphans', async () => {
  const linkedEdition = makeEditionRow({
    workUri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/gb.zyTCAlFPjgYC',
    workCid: 'bafyc',
  });
  const freshCid = await recomputeWorkCid(makeWorkRow({ uri: linkedEdition.workUri!, cid: 'bafyc' }));
  const workRow = makeWorkRow({ uri: linkedEdition.workUri!, cid: freshCid });
  const { db, capture } = createFakeDb({ editions: [linkedEdition], works: new Map([[workRow.uri, workRow]]) });
  capture.rows.push([], [linkedEdition], [workRow], []);
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], log: silentLog });
  assert.equal(summary.orphansFound, 0);
  assert.equal(summary.linked, 0);
  assert.equal(summary.created, 0);
});