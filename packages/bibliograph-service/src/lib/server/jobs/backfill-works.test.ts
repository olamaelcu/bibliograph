import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { recomputeWorkCid, runBackfill, shardPredicate } from './backfill-works';
import type { EditionRow, WorkRow } from '../db/schema';
import { PUBLISHER_DID } from '../did';
import { workRecordValue } from '../book-records';

const silentLog = pino({ level: 'silent' });

const WORK_URI = `at://${PUBLISHER_DID}/community.lexicon.book.work/work-1`;

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
    uri: WORK_URI,
    cid: 'bafyw1',
    did: PUBLISHER_DID,
    rkey: 'work-1',
    title: 'Test Edition',
    subtitle: null,
    originalLanguage: null,
    firstPublishedYear: 2024,
    subjects: [],
    contributors: [],
    identifiers: [{ type: 'isbn', value: '9780123456789' }],
    description: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    descriptionCheckedAt: null,
  };
  return Object.assign(base, overrides);
}

// ─── Sharding ─────────────────────────────────────────────────────────────

test('shardPredicate rejects a shard plan it cannot honour', () => {
  // One shard is the whole catalog — no predicate at all.
  assert.ok(shardPredicate(0, 1));
  assert.throws(() => shardPredicate(4, 4), /shardIndex/);
  assert.throws(() => shardPredicate(-1, 4), /shardIndex/);
  assert.throws(() => shardPredicate(0, 0), /shardCount/);
  // The first digest byte has 256 buckets, so more shards would be empty.
  assert.throws(() => shardPredicate(0, 300), /shardCount/);
  assert.throws(() => shardPredicate(1.5, 4), /shardIndex/);
});

// ─── CID recompute ────────────────────────────────────────────────────────

test('workRecordValue round-trips all stored columns', () => {
  const row = makeWorkRow({
    title: 'Round Trip',
    subtitle: 'Sub',
    originalLanguage: 'fr',
    firstPublishedYear: 1850,
    subjects: ['fiction'],
    contributors: [{ subject: { uri: 'at://x', cid: 'c' }, role: 'author' }],
    description: 'desc',
  });
  const value = workRecordValue(row, [{ name: 'Ada Lovelace', role: 'author' }]);
  assert.equal(value.title, 'Round Trip');
  assert.equal(value.subtitle, 'Sub');
  assert.equal(value.originalLanguage, 'fr');
  assert.equal(value.firstPublishedYear, 1850);
  assert.deepEqual(value.subjects, ['fiction']);
  assert.deepEqual(value.contributors, [{ name: 'Ada Lovelace', role: 'author' }]);
  assert.equal(value.description, 'desc');
  assert.equal(value.$type, 'community.lexicon.book.work');
});

test('recomputeWorkCid produces a deterministic CID for the same row data', async () => {
  const row = makeWorkRow();
  const cid1 = await recomputeWorkCid(row, []);
  const cid2 = await recomputeWorkCid(row, []);
  assert.equal(cid1, cid2);
  assert.match(cid1, /^bafy/);
});

test('recomputeWorkCid produces a different CID when row data changes', async () => {
  const a = makeWorkRow();
  const b = makeWorkRow({ title: 'Different Title' });
  const cidA = await recomputeWorkCid(a, []);
  const cidB = await recomputeWorkCid(b, []);
  assert.notEqual(cidA, cidB);
});

// ─── runBackfill integration (fake db) ────────────────────────────────────

interface CallCapture {
  /** Row sets handed back by successive `select`s, in call order. */
  rows: unknown[][];
  updateCalls: number;
}

interface FakeChain {
  select: () => FakeChain;
  from: (table: unknown) => FakeChain;
  where: (where?: unknown) => FakeChain;
  orderBy: (...args: unknown[]) => FakeChain;
  limit: (...args: unknown[]) => FakeChain;
  set: (...args: unknown[]) => FakeChain;
  then: <TResult1 = unknown, TResult2 = unknown>(
    onFulfilled?: ((v: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((e: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
}

function makeThenable(rows: unknown[]): FakeChain['then'] {
  return (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected);
}

function makeSelectBuilder(capture: CallCapture): FakeChain {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.from = () => builder;
  builder.where = () => builder;
  builder.orderBy = () => builder;
  builder.limit = () => builder;
  builder.then = makeThenable(capture.rows.shift() ?? []);
  return builder as unknown as FakeChain;
}

function makeUpdateBuilder(capture: CallCapture): FakeChain {
  const builder: Record<string, unknown> = {};
  builder.set = () => builder;
  builder.where = () => builder;
  builder.then = (onFulfilled?: ((v: unknown) => unknown) | null, onRejected?: ((e: unknown) => unknown) | null) => {
    capture.updateCalls++;
    return Promise.resolve([{ uri: 'at://updated' }] as unknown[]).then(onFulfilled, onRejected);
  };
  return builder as unknown as FakeChain;
}

/**
 * The job only ever selects and updates: phase 1 has no writer left, and phase 2
 * only rewrites drifted CIDs. `insert` throws so a re-added marker write or a
 * fabricated work row fails the assertions instead of silently passing.
 */
function createFakeDb(): { db: unknown; capture: CallCapture } {
  const capture: CallCapture = { rows: [], updateCalls: 0 };
  const dbProxy = {
    select: () => makeSelectBuilder(capture),
    update: () => makeUpdateBuilder(capture),
    insert: () => {
      throw new Error('runBackfill must not write work rows or backfill markers');
    },
  };
  return { db: dbProxy, capture };
}

type BackfillDb = Parameters<typeof runBackfill>[0]['db'];

function fakeDb(db: unknown): BackfillDb {
  return db as unknown as BackfillDb;
}

test('runBackfill Phase 1 defers every orphan instead of deciding or fabricating', async () => {
  // An ISBN is present, so the row is exactly the kind of edition the old
  // provider-backed pass would have searched for.
  const edition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/orphan-1',
    rkey: 'orphan-1',
    title: 'Some Book',
    identifiers: [{ type: 'isbn', value: '9780123456789' }],
    publishedYear: 2020,
  });
  const { db, capture } = createFakeDb();
  capture.rows.push(
    [edition], // phase-1 first page
    [],        // phase-1 second page (cursor past the only row)
    [],        // phase-2 first page
  );
  const summary = await runBackfill({ db: fakeDb(db), log: silentLog });
  assert.equal(summary.orphansFound, 1);
  assert.equal(summary.deferred, 1, 'no work source can answer, so the row is left for a later run');
  assert.equal(summary.unmatched, 0, 'an absent provider is not a fact about the catalog');
  assert.equal(summary.linked, 0);
  assert.equal(summary.created, 0, 'a synthetic work would count here');
  assert.equal(summary.skipped, 0);
  assert.equal(summary.failed, 0);
  // Nothing was written: no link, no marker, no work row.
  assert.equal(capture.updateCalls, 0);
});

test('runBackfill Phase 1 aborts once nothing can answer for a run of rows', async () => {
  // 26 orphans: one more than the consecutive-deferral cap, so the run must stop
  // before walking the rest of the slice.
  const editions = Array.from({ length: 26 }, (_, i) => makeEditionRow({
    uri: `at://did:plc:user/community.lexicon.book.edition/orphan-${i}`,
    rkey: `orphan-d-${i}`,
    title: `Book ${i}`,
    identifiers: [],
  }));
  const { db, capture } = createFakeDb();
  capture.rows.push(
    editions.slice(0, 10),
    editions.slice(10, 20),
    editions.slice(20),
    [], // phase-2 first page
  );
  const summary = await runBackfill({ db: fakeDb(db), log: silentLog, pageSize: 10 });
  assert.equal(summary.aborted, true);
  assert.equal(summary.orphansFound, 25, 'stops at the cap, not at the end of the slice');
  assert.equal(summary.deferred, 25);
  assert.equal(summary.failed, 0);
});

test('runBackfill Phase 2 re-verifies CIDs and counts updates', async () => {
  const linkedEdition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/linked-1',
    rkey: 'linked-1',
    workUri: WORK_URI,
    workCid: 'bafystale', // stale; will be recomputed and updated
  });
  const workRow = makeWorkRow({ uri: linkedEdition.workUri!, cid: 'bafystale', title: 'Some Book' });
  const { db, capture } = createFakeDb();
  capture.rows.push(
    [],              // phase-1 first page: no orphans
    [linkedEdition], // phase-2 first page
    [workRow],       // work row load inside the CID check
    [],              // phase-2 second page
  );
  const summary = await runBackfill({ db: fakeDb(db), log: silentLog });
  assert.equal(summary.orphansFound, 0);
  assert.equal(summary.cidsChecked, 1);
  assert.equal(summary.cidsUpdated, 1);
  assert.equal(capture.updateCalls, 2, 'work row CID and the edition work_cid');
});

test('runBackfill Phase 2 is a no-op when CID already matches', async () => {
  const linkedEdition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/linked-2',
    rkey: 'linked-2',
    workUri: WORK_URI,
  });
  const freshCid = await recomputeWorkCid(makeWorkRow({ uri: linkedEdition.workUri! }), []);
  const workRow = makeWorkRow({ uri: linkedEdition.workUri!, cid: freshCid });
  const { db, capture } = createFakeDb();
  capture.rows.push([], [linkedEdition], [workRow], []);
  const summary = await runBackfill({ db: fakeDb(db), log: silentLog });
  assert.equal(summary.cidsChecked, 1);
  assert.equal(summary.cidsUpdated, 0);
  assert.equal(capture.updateCalls, 0);
});

test('runBackfill second pass is a no-op when Phase 1 has no orphans', async () => {
  const linkedEdition = makeEditionRow({ workUri: WORK_URI, workCid: 'bafyc' });
  const freshCid = await recomputeWorkCid(makeWorkRow({ uri: linkedEdition.workUri!, cid: 'bafyc' }), []);
  const workRow = makeWorkRow({ uri: linkedEdition.workUri!, cid: freshCid });
  const { db, capture } = createFakeDb();
  capture.rows.push([], [linkedEdition], [workRow], []);
  const summary = await runBackfill({ db: fakeDb(db), log: silentLog });
  assert.equal(summary.orphansFound, 0);
  assert.equal(summary.linked, 0);
  assert.equal(summary.created, 0);
  assert.equal(capture.updateCalls, 0);
});
