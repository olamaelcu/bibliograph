import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMergedEdition, mergeEditionsInDb, type MergeEditionsResult } from './edition-merge';
import { editions, type EditionRow } from './db/schema';
import type { DbExecutor } from './stats';

const PRIMARY = 'at://did:web:biblio.test/community.lexicon.book.edition/primary';
const SOURCE = 'at://did:web:biblio.test/community.lexicon.book.edition/source';
const THIRD = 'at://did:web:biblio.test/community.lexicon.book.edition/third';

const AUTHOR = 'at://did:web:biblio.test/community.lexicon.book.contributor/author';
const TRANSLATOR = 'at://did:web:biblio.test/community.lexicon.book.contributor/translator';

function makeEditionRow(overrides: Partial<EditionRow> = {}): EditionRow {
  return {
    uri: PRIMARY,
    cid: 'bafyprimary',
    did: 'did:web:biblio.test',
    rkey: 'primary',
    title: 'Test Edition',
    subtitle: null,
    workUri: null,
    workCid: null,
    workLinkSource: null,
    publisherUri: null,
    publisherCid: null,
    place: null,
    publishedYear: 2024,
    language: 'en',
    contributors: [],
    identifiers: [],
    description: null,
    coverImageUrl: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    indexedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function primaryFixture(overrides: Partial<EditionRow> = {}): EditionRow {
  return makeEditionRow({
    uri: PRIMARY,
    rkey: 'primary',
    description: 'Primary description',
    coverImageUrl: 'https://covers.test/primary.jpg',
    identifiers: [{ uri: 'isbn:111', resource: 'isbn' }],
    contributors: [{ subject: { uri: AUTHOR, cid: 'bafyauthor' }, role: 'author' }],
    ...overrides,
  });
}

function sourceFixture(overrides: Partial<EditionRow> = {}): EditionRow {
  return makeEditionRow({
    uri: SOURCE,
    cid: 'bafysource',
    rkey: 'source',
    title: 'Source Edition',
    description: 'Source description',
    coverImageUrl: 'https://covers.test/source.jpg',
    identifiers: [
      { uri: 'isbn:111', resource: 'isbn' },
      { uri: 'isbn:111', resource: 'amazon' },
      { uri: 'ol:OL1W', resource: 'openlibrary' },
    ],
    contributors: [
      { subject: { uri: AUTHOR, cid: 'bafystale' }, role: 'author' },
      { subject: { uri: TRANSLATOR, cid: 'bafytranslator' }, role: 'translator' },
    ],
    ...overrides,
  });
}

test('computeMergedEdition unions identifiers and contributors, deduping on (uri, resource) and (subject.uri, role)', () => {
  const merged = computeMergedEdition([primaryFixture(), sourceFixture()], PRIMARY);

  assert.deepEqual(merged.identifiers, [
    { uri: 'isbn:111', resource: 'isbn' },
    { uri: 'isbn:111', resource: 'amazon' },
    { uri: 'ol:OL1W', resource: 'openlibrary' },
  ]);
  assert.deepEqual(merged.contributors, [
    { subject: { uri: AUTHOR, cid: 'bafyauthor' }, role: 'author' },
    { subject: { uri: TRANSLATOR, cid: 'bafytranslator' }, role: 'translator' },
  ]);
});

test('computeMergedEdition keeps first occurrence, so input order picks the surviving duplicate CID', () => {
  const merged = computeMergedEdition([sourceFixture(), primaryFixture()], PRIMARY);

  assert.deepEqual(merged.contributors, [
    { subject: { uri: AUTHOR, cid: 'bafystale' }, role: 'author' },
    { subject: { uri: TRANSLATOR, cid: 'bafytranslator' }, role: 'translator' },
  ]);
});

test('computeMergedEdition keeps the primary row identity and every non-union field', () => {
  const primary = primaryFixture({ place: 'Lisbon', publishedYear: 1999 });
  const merged = computeMergedEdition([primary, sourceFixture({ title: 'Source Edition' })], PRIMARY);

  assert.equal(merged.uri, PRIMARY);
  assert.equal(merged.cid, 'bafyprimary');
  assert.equal(merged.title, 'Test Edition');
  assert.equal(merged.place, 'Lisbon');
  assert.equal(merged.publishedYear, 1999);
});

test('computeMergedEdition falls back to the primary cover and description when the overrides are omitted', () => {
  const merged = computeMergedEdition([primaryFixture(), sourceFixture()], PRIMARY);

  assert.equal(merged.coverImageUrl, 'https://covers.test/primary.jpg');
  assert.equal(merged.description, 'Primary description');
});

test('computeMergedEdition applies explicit cover and description overrides', () => {
  const merged = computeMergedEdition(
    [primaryFixture(), sourceFixture()],
    PRIMARY,
    'https://covers.test/source.jpg',
    'Chosen description',
  );

  assert.equal(merged.coverImageUrl, 'https://covers.test/source.jpg');
  assert.equal(merged.description, 'Chosen description');
});

test('computeMergedEdition treats an empty override as a clear, not as a fallback', () => {
  const merged = computeMergedEdition([primaryFixture(), sourceFixture()], PRIMARY, '', '');

  assert.equal(merged.coverImageUrl, null);
  assert.equal(merged.description, null);
});

test('computeMergedEdition rejects a primary that is not among the merged editions', () => {
  assert.throws(
    () => computeMergedEdition([sourceFixture()], PRIMARY),
    /primaryUri must be in source editions/,
  );
});

test('computeMergedEdition leaves its inputs untouched', () => {
  const primary = primaryFixture();
  const source = sourceFixture();
  const primaryBefore = structuredClone(primary);
  const sourceBefore = structuredClone(source);

  computeMergedEdition([primary, source], PRIMARY);

  assert.deepEqual(primary, primaryBefore);
  assert.deepEqual(source, sourceBefore);
});

interface MergeCallCapture {
  updateTable?: unknown;
  updateSet?: Record<string, unknown>;
  updateWhere?: unknown;
  deleteTable?: unknown;
  deleteWhere?: unknown;
  deleteCount: number;
}

interface FakeTx {
  select(): { from(table: unknown): { where(condition: unknown): Promise<EditionRow[]> } };
  update(table: unknown): {
    set(values: Record<string, unknown>): { where(condition: unknown): Promise<void> };
  };
  delete(table: unknown): { where(condition: unknown): Promise<void> };
}

function createFakeDb(rows: EditionRow[], capture: MergeCallCapture): DbExecutor {
  const tx: FakeTx = {
    select() {
      return {
        from(table: unknown) {
          assert.equal(table, editions);
          return { where: async () => rows };
        },
      };
    },
    update(table: unknown) {
      capture.updateTable = table;
      return {
        set(values: Record<string, unknown>) {
          capture.updateSet = values;
          return {
            where: async (condition: unknown) => {
              capture.updateWhere = condition;
            },
          };
        },
      };
    },
    delete(table: unknown) {
      capture.deleteTable = table;
      return {
        where: async (condition: unknown) => {
          capture.deleteCount += 1;
          capture.deleteWhere = condition;
        },
      };
    },
  };

  return {
    transaction: async <T>(fn: (handle: FakeTx) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as DbExecutor;
}

/**
 * drizzle binds SQL params as objects carrying the literal value; column
 * references and keyword fragments carry no string `value`. Good enough to see
 * exactly which URIs a WHERE clause was built for.
 */
function sqlStringParams(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) sqlStringParams(child, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const candidate = node as { value?: unknown; queryChunks?: unknown };
  if (typeof candidate.value === 'string') out.push(candidate.value);
  if (Array.isArray(candidate.queryChunks)) sqlStringParams(candidate.queryChunks, out);
  return out;
}

test('mergeEditionsInDb writes the union to the primary and deletes only the other selected rows', async () => {
  const capture: MergeCallCapture = { deleteCount: 0 };
  const rows = [primaryFixture(), sourceFixture()];
  const db = createFakeDb(rows, capture);

  const result: MergeEditionsResult = await mergeEditionsInDb(db, [PRIMARY, SOURCE], PRIMARY);

  assert.deepEqual(capture.updateSet, {
    identifiers: [
      { uri: 'isbn:111', resource: 'isbn' },
      { uri: 'isbn:111', resource: 'amazon' },
      { uri: 'ol:OL1W', resource: 'openlibrary' },
    ],
    contributors: [
      { subject: { uri: AUTHOR, cid: 'bafyauthor' }, role: 'author' },
      { subject: { uri: TRANSLATOR, cid: 'bafytranslator' }, role: 'translator' },
    ],
    coverImageUrl: 'https://covers.test/primary.jpg',
    description: 'Primary description',
  });
  assert.deepEqual(sqlStringParams(capture.updateWhere), [PRIMARY]);
  assert.equal(capture.deleteTable, editions);
  assert.deepEqual(sqlStringParams(capture.deleteWhere), [SOURCE]);
  assert.equal(capture.deleteCount, 1);

  assert.deepEqual(result.deleted, [SOURCE]);
  assert.equal(result.merged.uri, PRIMARY);
  assert.equal(result.merged.title, 'Test Edition');
});

test('mergeEditionsInDb folds the winner in first even when the database returns it last', async () => {
  const capture: MergeCallCapture = { deleteCount: 0 };
  const db = createFakeDb([sourceFixture(), primaryFixture()], capture);

  const result = await mergeEditionsInDb(db, [SOURCE, PRIMARY], PRIMARY);

  assert.deepEqual(result.merged.contributors, [
    { subject: { uri: AUTHOR, cid: 'bafyauthor' }, role: 'author' },
    { subject: { uri: TRANSLATOR, cid: 'bafytranslator' }, role: 'translator' },
  ]);
  assert.deepEqual(result.merged.identifiers, [
    { uri: 'isbn:111', resource: 'isbn' },
    { uri: 'isbn:111', resource: 'amazon' },
    { uri: 'ol:OL1W', resource: 'openlibrary' },
  ]);
  assert.equal(result.merged.coverImageUrl, 'https://covers.test/primary.jpg');
  assert.deepEqual(result.deleted, [SOURCE]);
});

test('mergeEditionsInDb rejects a selection naming a row that does not exist, before writing anything', async () => {
  const capture: MergeCallCapture = { deleteCount: 0 };
  const db = createFakeDb([primaryFixture()], capture);

  await assert.rejects(mergeEditionsInDb(db, [PRIMARY, SOURCE], PRIMARY), {
    name: 'EditionMergeError',
    code: 'editions-missing',
    message: `No edition row for: ${SOURCE}`,
  });
  assert.equal(capture.updateSet, undefined);
  assert.equal(capture.deleteCount, 0);
});

test('mergeEditionsInDb applies the chosen cover and description while deleting the rest', async () => {
  const capture: MergeCallCapture = { deleteCount: 0 };
  const third = makeEditionRow({ uri: THIRD, rkey: 'third' });
  const db = createFakeDb([primaryFixture(), sourceFixture(), third], capture);

  await mergeEditionsInDb(db, [PRIMARY, SOURCE, THIRD], PRIMARY, 'https://covers.test/chosen.jpg', '');

  assert.equal(capture.updateSet?.coverImageUrl, 'https://covers.test/chosen.jpg');
  assert.equal(capture.updateSet?.description, null);
  assert.deepEqual(sqlStringParams(capture.deleteWhere), [SOURCE, THIRD]);
});

test('mergeEditionsInDb of a single edition updates it in place and deletes nothing', async () => {
  const capture: MergeCallCapture = { deleteCount: 0 };
  const db = createFakeDb([primaryFixture()], capture);

  const result = await mergeEditionsInDb(db, [PRIMARY], PRIMARY);

  assert.equal(capture.deleteCount, 0);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.merged.identifiers, [{ uri: 'isbn:111', resource: 'isbn' }]);
});

test('mergeEditionsInDb rejects a primary outside the selection before touching the database', async () => {
  const capture: MergeCallCapture = { deleteCount: 0 };
  const db = createFakeDb([primaryFixture(), sourceFixture()], capture);

  await assert.rejects(mergeEditionsInDb(db, [SOURCE], PRIMARY), /primaryUri must be in source editions/);
  assert.equal(capture.updateSet, undefined);
  assert.equal(capture.deleteCount, 0);
});
