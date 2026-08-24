import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { PostgresSource } from './postgres-source';
import { editions, works, contributors } from '../db/schema';
import type { EditionRow, WorkRow, ContributorRow } from '../db/schema';

interface CallCapture {
  whereCalled: boolean;
  orderByCalled: boolean;
  limit?: number;
  table?: unknown;
  whereValue?: unknown;
}

function createFakeDb(rows: unknown[], capture: CallCapture) {
  const builder: any = {
    select() { return builder; },
    from(table: unknown) { capture.table = table; return builder; },
    where(where: unknown) { capture.whereCalled = true; capture.whereValue = where; return builder; },
    orderBy() { capture.orderByCalled = true; return builder; },
    limit(n: number) { capture.limit = n; return builder; },
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

const silentLog = pino({ level: 'silent' });

function makeEditionRow(overrides: Partial<EditionRow> = {}): EditionRow {
  return {
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/r1',
    cid: 'bafytest',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: 'r1',
    title: 'Test Edition',
    subtitle: null,
    workUri: null,
    workCid: null,
    publisherUri: null,
    publisherCid: null,
    place: 'New York',
    publishedYear: 2024,
    language: 'en',
    contributors: [],
    identifiers: [{ uri: 'isbn:9780123456789', resource: 'isbn' }],
    description: null,
    coverImageUrl: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function makeWorkRow(overrides: Partial<WorkRow> = {}): WorkRow {
  return {
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/r1',
    cid: 'bafytest',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: 'r1',
    title: 'Test Work',
    subtitle: null,
    originalLanguage: 'en',
    firstPublishedYear: 2020,
    subjects: ['fiction'],
    contributors: [],
    identifiers: [],
    description: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function makeContributorRow(overrides: Partial<ContributorRow> = {}): ContributorRow {
  return {
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/r1',
    cid: 'bafytest',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: 'r1',
    name: 'Jane Doe',
    aliases: ['JD'],
    linkedDid: null,
    bio: 'Writes things',
    bornYear: 1970,
    diedYear: null,
    identifiers: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function encodeV1Cursor(t: string, u: string): string {
  return Buffer.from(JSON.stringify({ v: 1, src: 'postgres', t, u })).toString('base64url');
}

function encodeV2Cursor(t: string, u: string): string {
  return Buffer.from(JSON.stringify({ v: 2, src: 'postgres', t, u })).toString('base64url');
}

function decodeV2Cursor(cursor: string): { v: number; t: string; u: string } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString());
}

test('searchEditions applies q filter when provided', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const rows = [makeEditionRow()];
  const fakeDb = createFakeDb(rows, cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const result = await src.searchEditions({ q: 'foo', limit: 10 });

  assert.equal(cap.table, editions, 'queries editions table');
  assert.equal(cap.whereCalled, true, 'where() called when q present');
  assert.equal(cap.limit, 10, 'limit forwarded');
  assert.equal(result.items[0]?.title, 'Test Edition');
});

test('searchEditions omits where when no q/id/cursor', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const rows: EditionRow[] = [];
  const fakeDb = createFakeDb(rows, cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const result = await src.searchEditions({ limit: 20 });

  assert.equal(cap.whereCalled, false, 'no where clause for unfiltered query');
  assert.equal(result.items.length, 0);
});

test('searchEditions applies id filter when provided', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fakeDb = createFakeDb([makeEditionRow()], cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  await src.searchEditions({ id: ['isbn:9780123456789'], limit: 10 });

  assert.equal(cap.whereCalled, true);
});

test('searchEditions decodes v1 cursor (back-compat)', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const rows = [makeEditionRow({ indexedAt: new Date('2024-02-01T00:00:00Z'), uri: 'at://x/edition/r2' })];
  const fakeDb = createFakeDb(rows, cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const v1Cursor = encodeV1Cursor('2024-01-01T00:00:00Z', 'at://x/edition/r1');
  const result = await src.searchEditions({ cursor: v1Cursor, limit: 10 });

  assert.equal(cap.whereCalled, true, 'v1 cursor still produces a where clause');
  assert.equal(result.items.length, 1);
});

test('searchEditions round-trips v2 cursor when page is full', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fullPage = [
    makeEditionRow({ uri: 'at://x/edition/r1', indexedAt: new Date('2024-03-01T00:00:00Z') }),
    makeEditionRow({ uri: 'at://x/edition/r2', indexedAt: new Date('2024-02-01T00:00:00Z') }),
  ];
  const fakeDb = createFakeDb(fullPage, cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const result = await src.searchEditions({ limit: 2 });

  assert.ok(result.cursor, 'cursor emitted when rows.length === limit');
  const decoded = decodeV2Cursor(result.cursor!);
  assert.equal(decoded.v, 2);
  assert.equal(decoded.u, 'at://x/edition/r2');
  assert.equal(decoded.t, '2024-02-01T00:00:00.000Z');
});

test('searchEditions omits cursor when page is partial', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fakeDb = createFakeDb([makeEditionRow()], cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const result = await src.searchEditions({ limit: 10 });

  assert.equal(result.cursor, undefined);
});

test('searchEditions maps edition rows to EditionItem', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const row = makeEditionRow({
    contributors: [{ subject: { uri: 'at://x/c/r1', cid: 'bafyc' }, role: 'author' }],
  });
  const fakeDb = createFakeDb([row], cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const result = await src.searchEditions({ limit: 10 });

  const item = result.items[0]!;
  assert.equal(item.uri, row.uri);
  assert.equal(item.title, 'Test Edition');
  assert.equal(item.publishedYear, 2024);
  assert.equal(item.place, 'New York');
  assert.equal(item.language, 'en');
  assert.equal(item.coverImageUrl, undefined);
  assert.deepEqual(item.identifiers, [{ uri: 'isbn:9780123456789', resource: 'isbn' }]);
  assert.deepEqual(item.contributors, [{ subject: { uri: 'at://x/c/r1', cid: 'bafyc' }, role: 'author' }]);
  assert.equal(item.createdAt, '2024-01-01T00:00:00.000Z');
});

test('searchWorks queries works table and maps WorkItem', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fakeDb = createFakeDb([makeWorkRow()], cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const result = await src.searchWorks({ limit: 10 });

  assert.equal(cap.table, works, 'queries works table');
  assert.equal(result.items[0]?.title, 'Test Work');
  assert.equal(result.items[0]?.originalLanguage, 'en');
  assert.deepEqual(result.items[0]?.subjects, ['fiction']);
});

test('searchWorks decodes v1 cursor (back-compat)', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fakeDb = createFakeDb([makeWorkRow()], cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const v1Cursor = encodeV1Cursor('2024-01-01T00:00:00Z', 'at://x/work/r1');
  await src.searchWorks({ cursor: v1Cursor, limit: 10 });

  assert.equal(cap.whereCalled, true);
});

test('searchContributors queries contributors table and maps ContributorItem', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fakeDb = createFakeDb([makeContributorRow()], cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const result = await src.searchContributors({ limit: 10 });

  assert.equal(cap.table, contributors, 'queries contributors table');
  assert.equal(result.items[0]?.name, 'Jane Doe');
  assert.deepEqual(result.items[0]?.aliases, ['JD']);
  assert.equal(result.items[0]?.bornYear, 1970);
  assert.equal(result.items[0]?.bio, 'Writes things');
});

test('searchContributors decodes v1 cursor (back-compat)', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fakeDb = createFakeDb([makeContributorRow()], cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const v1Cursor = encodeV1Cursor('2024-01-01T00:00:00Z', 'at://x/contributor/r1');
  await src.searchContributors({ cursor: v1Cursor, limit: 10 });

  assert.equal(cap.whereCalled, true);
});

test('searchContributors emits v2 cursor on full page', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fullPage = [
    makeContributorRow({ uri: 'at://x/c/r1', indexedAt: new Date('2024-03-01T00:00:00Z') }),
    makeContributorRow({ uri: 'at://x/c/r2', indexedAt: new Date('2024-02-01T00:00:00Z') }),
  ];
  const fakeDb = createFakeDb(fullPage, cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const result = await src.searchContributors({ limit: 2 });

  assert.ok(result.cursor);
  const decoded = decodeV2Cursor(result.cursor!);
  assert.equal(decoded.v, 2);
});

test('all three methods log with did: PUBLISHER_DID', async () => {
  const records: Array<{ kind: string; did?: string }> = [];
  const log = pino({ level: 'info' }, {
    write(s: string) {
      const line = JSON.parse(s);
      if (line.stage === 'postgres-source') {
        records.push({ kind: line.kind, did: line.did });
      }
    },
  });

  for (const setup of [
    { table: editions, row: makeEditionRow(), method: 'searchEditions' as const },
    { table: works, row: makeWorkRow(), method: 'searchWorks' as const },
    { table: contributors, row: makeContributorRow(), method: 'searchContributors' as const },
  ]) {
    const cap: CallCapture = { whereCalled: false, orderByCalled: false };
    const fakeDb = createFakeDb([setup.row], cap);
    const src = new PostgresSource(log, fakeDb as never);
    await src[setup.method]({ limit: 10 });
  }

  assert.equal(records.length, 3);
  for (const r of records) {
    assert.ok(typeof r.did === 'string' && r.did.startsWith('did:'), `${r.kind} log includes did`);
  }
});

test('invalid cursor (wrong src) is ignored — no where clause', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fakeDb = createFakeDb([makeEditionRow()], cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  const wrongSrc = Buffer.from(JSON.stringify({ v: 2, src: 'openlibrary', p: 1 })).toString('base64url');
  await src.searchEditions({ cursor: wrongSrc, limit: 10 });

  assert.equal(cap.whereCalled, false);
});

test('malformed cursor is ignored — no where clause', async () => {
  const cap: CallCapture = { whereCalled: false, orderByCalled: false };
  const fakeDb = createFakeDb([makeEditionRow()], cap);
  const src = new PostgresSource(silentLog, fakeDb as never);

  await src.searchEditions({ cursor: 'not-base64-at-all!!!', limit: 10 });

  assert.equal(cap.whereCalled, false);
});