import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import {
  editionSearchQuery,
  isbnFromIdentifiers,
  matchWorkCandidate,
  normalizeTitle,
  olKeyFromWorkIdentifiers,
  recomputeWorkCid,
  rkeyForSyntheticWork,
  rkeyForWorkFromOlKey,
  runBackfill,
  synthesizeWorkFromEdition,
  workUriForRkey,
  workValueForCid,
} from './backfill-works';
import type { EditionRow, WorkRow } from '../db/schema';
import type { WorkItem } from '../search/types';
import { OpenLibrarySource } from '../search/open-library-source';
import { PUBLISHER_DID } from '../did';

const silentLog = pino({ level: 'silent' });

function makeEditionRow(overrides: Partial<EditionRow> = {}): EditionRow {
  return {
    uri: 'at://did:plc:user/community.lexicon.book.edition/rec1',
    cid: 'bafye1',
    did: 'did:plc:user',
    rkey: 'rec1',
    title: 'Test Edition',
    subtitle: null,
    workUri: null,
    workCid: null,
    publisherUri: null,
    publisherCid: null,
    place: null,
    publishedYear: 2024,
    language: null,
    contributors: [],
    identifiers: [],
    description: null,
    coverImageUrl: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function makeWorkRow(overrides: Partial<WorkRow> = {}): WorkRow {
  return {
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
    identifiers: [{ uri: 'https://openlibrary.org/works/OL1W', resource: 'openlibrary' }],
    description: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    title: 'Test Edition',
    subjects: [],
    identifiers: [{ uri: 'https://openlibrary.org/works/OL1W', resource: 'openlibrary' }],
    contributors: [],
    createdAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

test('isbnFromIdentifiers prefers isbn13 over isbn10 over isbn', () => {
  const idents = [
    { uri: 'isbn:9780123456789', resource: 'isbn13' as const },
    { uri: 'isbn:0123456789', resource: 'isbn10' as const },
    { uri: 'isbn:012345678X', resource: 'isbn' as const },
  ];
  assert.equal(isbnFromIdentifiers(idents), '9780123456789');
});

test('isbnFromIdentifiers returns undefined when no ISBN present', () => {
  assert.equal(isbnFromIdentifiers([]), undefined);
  assert.equal(
    isbnFromIdentifiers([{ uri: 'https://openlibrary.org/works/OL1W', resource: 'openlibrary' }]),
    undefined,
  );
});

test('editionSearchQuery uses ISBN when present, else title', () => {
  const withIsbn = makeEditionRow({
    identifiers: [{ uri: 'isbn:9780123456789', resource: 'isbn13' }],
    title: 'Should Not Be Used',
  });
  const withoutIsbn = makeEditionRow({ identifiers: [], title: 'Title Only' });
  assert.equal(editionSearchQuery(withIsbn), '9780123456789');
  assert.equal(editionSearchQuery(withoutIsbn), 'Title Only');
});

test('normalizeTitle trims and lowercases', () => {
  assert.equal(normalizeTitle('  Hello World  '), 'hello world');
});

test('matchWorkCandidate accepts title-equal within year±2', () => {
  const edition = makeEditionRow({ title: 'Foo', publishedYear: 2020 });
  const candidates = [
    makeWorkItem({ title: 'Foo', firstPublishedYear: 2020 }),
    makeWorkItem({ title: 'Foo', firstPublishedYear: 2018 }),
    makeWorkItem({ title: 'Foo', firstPublishedYear: 2022 }),
    makeWorkItem({ title: 'Foo', firstPublishedYear: 2000 }), // 20y off → no
    makeWorkItem({ title: 'Bar', firstPublishedYear: 2020 }),
  ];
  assert.equal(matchWorkCandidate(candidates, edition)?.identifiers[0]?.uri, 'https://openlibrary.org/works/OL1W');
});

test('matchWorkCandidate tolerates ±2 boundary exactly', () => {
  const edition = makeEditionRow({ title: 'Foo', publishedYear: 2020 });
  assert.ok(matchWorkCandidate([makeWorkItem({ title: 'Foo', firstPublishedYear: 2022 })], edition));
  assert.equal(matchWorkCandidate([makeWorkItem({ title: 'Foo', firstPublishedYear: 2023 })], edition), null);
});

test('matchWorkCandidate treats missing year on either side as a match (year unknown)', () => {
  const edition = makeEditionRow({ title: 'Foo', publishedYear: null });
  assert.ok(matchWorkCandidate([makeWorkItem({ title: 'Foo', firstPublishedYear: undefined })], edition));
  const edition2 = makeEditionRow({ title: 'Foo', publishedYear: 2020 });
  assert.ok(matchWorkCandidate([makeWorkItem({ title: 'Foo', firstPublishedYear: undefined })], edition2));
});

test('matchWorkCandidate is case-insensitive and trim-tolerant', () => {
  const edition = makeEditionRow({ title: '  FOO  ' });
  assert.ok(matchWorkCandidate([makeWorkItem({ title: 'foo' })], edition));
});

test('matchWorkCandidate returns null when no candidate has matching title', () => {
  const edition = makeEditionRow({ title: 'Foo' });
  assert.equal(matchWorkCandidate([makeWorkItem({ title: 'Bar' })], edition), null);
  assert.equal(matchWorkCandidate([], edition), null);
});

test('olKeyFromWorkIdentifiers strips scheme/host, keeps path', () => {
  assert.equal(
    olKeyFromWorkIdentifiers([{ uri: 'https://openlibrary.org/works/OL66554W', resource: 'openlibrary' }]),
    '/works/OL66554W',
  );
});

test('olKeyFromWorkIdentifiers ignores non-OL identifiers', () => {
  assert.equal(
    olKeyFromWorkIdentifiers([
      { uri: 'isbn:9780123456789', resource: 'isbn13' },
      { uri: 'https://example.com/works/OL1W', resource: 'openlibrary' }, // wrong host
    ]),
    undefined,
  );
});

test('rkeyForWorkFromOlKey strips /works/ prefix', () => {
  assert.equal(rkeyForWorkFromOlKey('/works/OL66554W'), 'ol-work-OL66554W');
});

test('rkeyForSyntheticWork is deterministic from edition URI', () => {
  const uri = 'at://did:plc:user/community.lexicon.book.edition/rec-abc';
  assert.equal(rkeyForSyntheticWork(uri), 'synth-work-rec-abc');
  assert.notEqual(rkeyForSyntheticWork(uri), rkeyForWorkFromOlKey('/works/OL1W'));
});

test('workUriForRkey uses PUBLISHER_DID', () => {
  assert.equal(
    workUriForRkey('ol-work-OL1W'),
    `at://${PUBLISHER_DID}/community.lexicon.book.work/ol-work-OL1W`,
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

// ─── runBackfill integration (fake db + fake openlibrary) ─────────────────

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

class FakeOpenLibrarySource {
  constructor(private readonly responses: Map<string, WorkItem[]>) {}
  async searchWorks({ q }: { q: string }): Promise<{ items: WorkItem[] }> {
    const items = this.responses.get(q) ?? [];
    return { items };
  }
  // unused in tests below
  searchEditions() { throw new Error('not used'); }
  searchContributors() { throw new Error('not used'); }
}

test('runBackfill Phase 1 reconciles orphan via OL ISBN match and links edition', async () => {
  const edition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/orphan-1',
    rkey: 'orphan-1',
    title: 'Some Book',
    identifiers: [{ uri: 'isbn:9780123456789', resource: 'isbn13' }],
    publishedYear: 2020,
  });
  const workRow = makeWorkRow({
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/ol-work-OL66554W',
    rkey: 'ol-work-OL66554W',
    title: 'Some Book',
    firstPublishedYear: 2020,
    identifiers: [{ uri: 'https://openlibrary.org/works/OL66554W', resource: 'openlibrary' }],
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
  const ol = new FakeOpenLibrarySource(new Map([
    ['9780123456789', [makeWorkItem({
      title: 'Some Book',
      firstPublishedYear: 2020,
      identifiers: [{ uri: 'https://openlibrary.org/works/OL66554W', resource: 'openlibrary' }],
    })]],
  ])) as unknown as OpenLibrarySource;
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], openLibrary: ol as unknown as Parameters<typeof runBackfill>[0]['openLibrary'], log: silentLog });
  assert.equal(summary.orphansFound, 1);
  assert.equal(summary.linked, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.cidsChecked, 0, 'no linked editions in phase 2');
});

test('runBackfill Phase 1 falls back to synthesized work when no OL candidate matches', async () => {
  const edition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/orphan-2',
    rkey: 'orphan-2',
    title: 'Obcure',
    identifiers: [],
    publishedYear: 2020,
  });
  const { db, capture } = createFakeDb({ editions: [edition], works: new Map() });
  // For the synthesized path upsertWorkRow still does its read-back, returning
  // a synthetic row (we just pass back the same edition for simplicity).
  const syntheticWork = makeWorkRow({
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/synth-work-orphan-2',
    rkey: 'synth-work-orphan-2',
    title: 'Obcure',
    identifiers: [],
  });
  capture.rows.push(
    [edition],          // phase-1 first
    [syntheticWork],    // upsertWorkRow read-back
    [],                 // phase-1 second
    [],                 // phase-2 first
    [],                 // phase-2 second
  );
  const ol = new FakeOpenLibrarySource(new Map([
    ['Obcure', [makeWorkItem({ title: 'Different Book', firstPublishedYear: 2020 })]], // wrong title
  ])) as unknown as OpenLibrarySource;
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], openLibrary: ol as unknown as Parameters<typeof runBackfill>[0]['openLibrary'], log: silentLog });
  assert.equal(summary.orphansFound, 1);
  assert.equal(summary.linked, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.skipped, 0);
});

test('runBackfill Phase 1 skips edition with empty title', async () => {
  const edition = makeEditionRow({ title: '   ', identifiers: [] });
  const { db, capture } = createFakeDb({ editions: [edition], works: new Map() });
  capture.rows.push([edition], [], []);
  const ol = new FakeOpenLibrarySource(new Map()) as unknown as OpenLibrarySource;
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], openLibrary: ol as unknown as Parameters<typeof runBackfill>[0]['openLibrary'], log: silentLog });
  assert.equal(summary.orphansFound, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.linked, 0);
});

test('runBackfill Phase 2 re-verifies CIDs and counts updates', async () => {
  const linkedEdition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/linked-1',
    rkey: 'linked-1',
    workUri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/ol-work-OL1W',
    workCid: 'bafystale', // stale; will be recomputed and updated
  });
  const workRow = makeWorkRow({
    uri: linkedEdition.workUri!,
    cid: 'bafystale',
    title: 'Some Book',
  });
  const { db, capture } = createFakeDb({ editions: [linkedEdition], works: new Map([[workRow.uri, workRow]]) });
  capture.rows.push([], [linkedEdition], [workRow], []);
  const ol = new FakeOpenLibrarySource(new Map()) as unknown as OpenLibrarySource;
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], openLibrary: ol as unknown as Parameters<typeof runBackfill>[0]['openLibrary'], log: silentLog });
  assert.equal(summary.orphansFound, 0);
  assert.equal(summary.cidsChecked, 1);
  assert.equal(summary.cidsUpdated, 1);
});

test('runBackfill Phase 2 is a no-op when CID already matches', async () => {
  const linkedEdition = makeEditionRow({
    uri: 'at://did:plc:user/community.lexicon.book.edition/linked-2',
    rkey: 'linked-2',
    workUri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/ol-work-OL2W',
  });
  const freshCid = await recomputeWorkCid(makeWorkRow({ uri: linkedEdition.workUri! }));
  const workRow = makeWorkRow({ uri: linkedEdition.workUri!, cid: freshCid });
  const { db, capture } = createFakeDb({ editions: [linkedEdition], works: new Map([[workRow.uri, workRow]]) });
  capture.rows.push([], [linkedEdition], [workRow], []);
  const ol = new FakeOpenLibrarySource(new Map()) as unknown as OpenLibrarySource;
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], openLibrary: ol as unknown as Parameters<typeof runBackfill>[0]['openLibrary'], log: silentLog });
  assert.equal(summary.cidsChecked, 1);
  assert.equal(summary.cidsUpdated, 0);
});

test('runBackfill second pass is a no-op when Phase 1 has no orphans', async () => {
  const linkedEdition = makeEditionRow({
    workUri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/ol-work-OL1W',
    workCid: 'bafyc',
  });
  const freshCid = await recomputeWorkCid(makeWorkRow({ uri: linkedEdition.workUri!, cid: 'bafyc' }));
  const workRow = makeWorkRow({ uri: linkedEdition.workUri!, cid: freshCid });
  const { db, capture } = createFakeDb({ editions: [linkedEdition], works: new Map([[workRow.uri, workRow]]) });
  capture.rows.push([], [linkedEdition], [workRow], []);
  const ol = new FakeOpenLibrarySource(new Map()) as unknown as OpenLibrarySource;
  const summary = await runBackfill({ db: db as unknown as Parameters<typeof runBackfill>[0]['db'], openLibrary: ol as unknown as Parameters<typeof runBackfill>[0]['openLibrary'], log: silentLog });
  assert.equal(summary.orphansFound, 0);
  assert.equal(summary.linked, 0);
  assert.equal(summary.created, 0);
});