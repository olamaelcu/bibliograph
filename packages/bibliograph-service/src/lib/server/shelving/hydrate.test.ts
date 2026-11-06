import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bookUriForRow,
  catalogEditionUriFromRkey,
  displayNameForShelfRkey,
  resolveBookShelf,
} from './hydrate.js';
import type { RecordRow } from '../db/schema';
import type { NetOlamaelcuLivtetBiblioDefs } from '../lexicons/index.js';
import { PUBLISHER_DID } from '../did';

const SHELF_URI = `at://did:plc:e2ctbutx6kya6si4if5ngjmm/net.olamaelcu.livtet.biblio.shelf/to-read`;
const SHELVING_URI = `at://did:plc:e2ctbutx6kya6si4if5ngjmm/net.olamaelcu.livtet.biblio.bookShelving/rk`;
const EDITION_URI_GB = `at://${PUBLISHER_DID}/community.lexicon.book.edition/gb.qzybEQAAQBAJ`;
const EDITION_URI_ISBNDB = `at://${PUBLISHER_DID}/community.lexicon.book.edition/isbndb.9781607785927`;

function makeBookView(uri: string, title = 'Some Book'): NetOlamaelcuLivtetBiblioDefs.BookView {
  return {
    // eslint-disable-next-line @typescript-eslint/no-restricted-types
    uri: uri as never,
    title,
    $type: 'net.olamaelcu.livtet.biblio.defs#bookView' as const,
  };
}

function makeShelfView(uri: string, name = ''): NetOlamaelcuLivtetBiblioDefs.ShelfView {
  return {
    // eslint-disable-next-line @typescript-eslint/no-restricted-types
    uri: uri as never,
    name,
    $type: 'net.olamaelcu.livtet.biblio.defs#shelfView' as const,
  };
}

function makeShelvingRow(opts: {
  rkey: string;
  shelfUri?: string;
  bookRef?: { uri: string } | null;
  did?: string;
}): RecordRow {
  return {
    uri: `at://did:plc:user/net.olamaelcu.livtet.biblio.bookShelving/${opts.rkey}`,
    cid: 'bafyplaceholder',
    did: opts.did ?? 'did:plc:user',
    rkey: opts.rkey,
    collection: 'net.olamaelcu.livtet.biblio.bookShelving',
    value: {
      shelf: opts.shelfUri ?? SHELF_URI,
      book: opts.bookRef === null ? null : (opts.bookRef ?? { uri: '' }),
      metadata: { status: 'to-read' },
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-restricted-types
    } as never,
    recordCreatedAt: '2026-08-26T00:00:00.000Z',
    createdAt: new Date('2026-08-26T00:00:00Z'),
    indexedAt: new Date('2026-08-26T00:00:00Z'),
  };
}

// ─── catalogEditionUriFromRkey ──────────────────────────────────────────────

test('catalogEditionUriFromRkey maps gb.<vid> to catalog edition URI', () => {
  assert.equal(
    catalogEditionUriFromRkey('gb.qzybEQAAQBAJ'),
    EDITION_URI_GB,
  );
});

test('catalogEditionUriFromRkey maps isbndb.<isbn> to catalog edition URI', () => {
  assert.equal(
    catalogEditionUriFromRkey('isbndb.9781607785927'),
    EDITION_URI_ISBNDB,
  );
});

test('catalogEditionUriFromRkey returns null for invalid gb rkey', () => {
  // gb. is too short to pass GB_VOLUME_RE (min 8 chars).
  assert.equal(catalogEditionUriFromRkey('gb.bad'), null);
});

test('catalogEditionUriFromRkey returns null for non-edition and retired rkeys', () => {
  // Work rkey (ol.W...) and contributor rkey (ol.A...) are not editions.
  assert.equal(catalogEditionUriFromRkey('ol.W66554W'), null);
  assert.equal(catalogEditionUriFromRkey('ol.A12345A'), null);
  // `ol.` edition rkeys are retired with the OpenLibrary source: no provider
  // owns them, so a stale shelving reference resolves to nothing.
  assert.equal(catalogEditionUriFromRkey('ol.OL32984650M'), null);
});

test('catalogEditionUriFromRkey returns null for unknown prefix', () => {
  assert.equal(catalogEditionUriFromRkey('abc.xyz'), null);
});

// ─── displayNameForShelfRkey ───────────────────────────────────────────────

test('displayNameForShelfRkey returns canon display names', () => {
  assert.equal(displayNameForShelfRkey('reading'), 'Currently Reading');
  assert.equal(displayNameForShelfRkey('to-read'), 'To Read');
  assert.equal(displayNameForShelfRkey('read'), 'Read');
  assert.equal(displayNameForShelfRkey('dnf'), 'Did Not Finish');
});

test('displayNameForShelfRkey returns null for custom rkeys', () => {
  assert.equal(displayNameForShelfRkey('wishlist'), null);
});

// ─── resolveBookShelf: strongRef populated ─────────────────────────────────

test('resolveBookShelf: explicit book.uri resolves when in bookMap', () => {
  const row = makeShelvingRow({
    rkey: 'gb.qzybEQAAQBAJ',
    bookRef: { uri: EDITION_URI_GB },
  });
  const bookMap = new Map([[EDITION_URI_GB, makeBookView(EDITION_URI_GB, 'Test GB')]]);
  const shelfMap = new Map();
  const result = resolveBookShelf(row, bookMap, shelfMap);
  assert.equal(result.ok, true);
  assert.ok(result.view);
  assert.equal(result.view!.book.uri, EDITION_URI_GB);
  assert.equal(result.view!.book.title, 'Test GB');
});

test('resolveBookShelf: empty book.uri falls back to rkey-derived URI', () => {
  const row = makeShelvingRow({
    rkey: 'gb.qzybEQAAQBAJ',
    bookRef: { uri: '' },
  });
  const bookMap = new Map([[EDITION_URI_GB, makeBookView(EDITION_URI_GB, 'Fallback Title')]]);
  const shelfMap = new Map();
  const result = resolveBookShelf(row, bookMap, shelfMap);
  assert.equal(result.ok, true);
  assert.ok(result.view);
  assert.equal(result.view!.book.uri, EDITION_URI_GB);
  assert.equal(result.view!.book.title, 'Fallback Title');
});

test('resolveBookShelf: empty book.uri with isbndb. rkey falls back', () => {
  const row = makeShelvingRow({
    rkey: 'isbndb.9781607785927',
    bookRef: { uri: '' },
  });
  const bookMap = new Map([[EDITION_URI_ISBNDB, makeBookView(EDITION_URI_ISBNDB, 'ISBNdb Book')]]);
  const result = resolveBookShelf(row, bookMap, new Map());
  assert.equal(result.ok, true);
  assert.equal(result.view!.book.uri, EDITION_URI_ISBNDB);
});

test('resolveBookShelf: drops row when neither strongRef nor rkey resolves', () => {
  const row = makeShelvingRow({
    rkey: 'gb.qzybEQAAQBAJ',
    bookRef: { uri: '' },
  });
  // bookMap is empty — fallback URI not present.
  const result = resolveBookShelf(row, new Map(), new Map());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'book-not-found');
});

test('resolveBookShelf: drops row when rkey is unparseable', () => {
  const row = makeShelvingRow({
    rkey: 'garbage-rkey',
    bookRef: { uri: '' },
  });
  const result = resolveBookShelf(row, new Map(), new Map());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'book-not-found');
});

// ─── resolveBookShelf: shelf naming ─────────────────────────────────────────

test('resolveBookShelf: uses display-name table when shelf cache is cold', () => {
  const row = makeShelvingRow({
    rkey: 'gb.qzybEQAAQBAJ',
    bookRef: { uri: EDITION_URI_GB },
    shelfUri: SHELF_URI,
  });
  const bookMap = new Map([[EDITION_URI_GB, makeBookView(EDITION_URI_GB)]]);
  // shelfMap is empty — cache miss.
  const result = resolveBookShelf(row, bookMap, new Map());
  assert.equal(result.ok, true);
  assert.equal(result.view!.shelf.uri, SHELF_URI);
  assert.equal(result.view!.shelf.name, 'To Read');
});

test('resolveBookShelf: cached shelf name wins over display-name table', () => {
  const row = makeShelvingRow({
    rkey: 'gb.qzybEQAAQBAJ',
    bookRef: { uri: EDITION_URI_GB },
    shelfUri: SHELF_URI,
  });
  const bookMap = new Map([[EDITION_URI_GB, makeBookView(EDITION_URI_GB)]]);
  const shelfMap = new Map([
    [SHELF_URI, makeShelfView(SHELF_URI, 'My Custom Shelf Name')],
  ]);
  const result = resolveBookShelf(row, bookMap, shelfMap);
  assert.equal(result.ok, true);
  assert.equal(result.view!.shelf.name, 'My Custom Shelf Name');
});

test('resolveBookShelf: empty cached name falls back to display-name table', () => {
  const row = makeShelvingRow({
    rkey: 'gb.qzybEQAAQBAJ',
    bookRef: { uri: EDITION_URI_GB },
    shelfUri: SHELF_URI,
  });
  const bookMap = new Map([[EDITION_URI_GB, makeBookView(EDITION_URI_GB)]]);
  const shelfMap = new Map([[SHELF_URI, makeShelfView(SHELF_URI, '')]]);
  const result = resolveBookShelf(row, bookMap, shelfMap);
  assert.equal(result.view!.shelf.name, 'To Read');
});

// ─── resolveBookShelf: invariant preservation ───────────────────────────────

test('resolveBookShelf: preserves uri, did, metadata, createdAt, updatedAt', () => {
  const row = makeShelvingRow({
    rkey: 'gb.qzybEQAAQBAJ',
    bookRef: { uri: EDITION_URI_GB },
    did: 'did:plc:e2ctbutx6kya6si4if5ngjmm',
  });
  const bookMap = new Map([[EDITION_URI_GB, makeBookView(EDITION_URI_GB)]]);
  const result = resolveBookShelf(row, bookMap, new Map());
  assert.equal(result.ok, true);
  assert.equal(result.view!.uri, row.uri);
  assert.equal(result.view!.did, 'did:plc:e2ctbutx6kya6si4if5ngjmm');
  assert.deepEqual(result.view!.metadata, { status: 'to-read' });
  assert.equal(result.view!.createdAt, '2026-08-26T00:00:00.000Z');
  assert.equal(result.view!.updatedAt, '2026-08-26T00:00:00.000Z');
});

// ─── resolveBookShelf: bookhive rows ────────────────────────────────────────

const HIVE_ID = 'bk_Wf9C5GP9iEGH6hqNNtwW';
const EDITION_URI_BH = `at://${PUBLISHER_DID}/community.lexicon.book.edition/bh.${HIVE_ID}`;

function makeBookhiveRow(
  opts: {
    status?: string;
    hiveBookUri?: string | null;
    title?: string;
    authors?: string;
    startedAt?: string;
    finishedAt?: string;
  } = {},
): RecordRow {
  return {
    uri: 'at://did:plc:reader/buzz.bookhive.book/3lct6cguexs2p',
    cid: 'bafyplaceholder',
    did: 'did:plc:reader',
    rkey: '3lct6cguexs2p',
    collection: 'buzz.bookhive.book',
    value: {
      hiveId: HIVE_ID,
      ...(opts.hiveBookUri === null
        ? {}
        : { hiveBookUri: opts.hiveBookUri ?? `at://did:plc:enu2j5xjlqsjaylv3du4myh4/buzz.bookhive.catalogBook/${HIVE_ID}` }),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.authors ? { authors: opts.authors } : {}),
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
      ...(opts.finishedAt ? { finishedAt: opts.finishedAt } : {}),
      status: opts.status ?? 'buzz.bookhive.defs#finished',
      review: 'A good read',
      createdAt: '2026-08-26T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-restricted-types
    } as never,
    recordCreatedAt: '2026-08-26T00:00:00.000Z',
    createdAt: new Date('2026-08-26T00:00:00Z'),
    indexedAt: new Date('2026-08-26T00:00:00Z'),
  };
}

test('resolveBookShelf: bookhive status becomes metadata.status', () => {
  const bookMap = new Map([[EDITION_URI_BH, makeBookView(EDITION_URI_BH)]]);
  const result = resolveBookShelf(makeBookhiveRow(), bookMap, new Map());
  assert.equal(result.ok, true);
  assert.deepEqual(result.view!.metadata, { status: 'read' });
  assert.equal(result.view!.shelf.name, 'Read');
  assert.equal(result.view!.uri, 'at://did:plc:reader/buzz.bookhive.book/3lct6cguexs2p');
  assert.equal(result.view!.book.uri, EDITION_URI_BH);
  assert.equal(result.view!.createdAt, '2026-08-26T00:00:00.000Z');
});

test('resolveBookShelf: bookhive reading status maps to its own shelf', () => {
  const bookMap = new Map([[EDITION_URI_BH, makeBookView(EDITION_URI_BH)]]);
  const result = resolveBookShelf(makeBookhiveRow({ status: 'buzz.bookhive.defs#reading' }), bookMap, new Map());
  assert.deepEqual(result.view!.metadata, { status: 'reading' });
  assert.equal(result.view!.shelf.name, 'Currently Reading');
});

test('resolveBookShelf: bookhive row falls back to the record when its edition is not in the catalog', () => {
  const result = resolveBookShelf(
    makeBookhiveRow({ title: 'The Creative Act', authors: 'Rick Rubin' }),
    new Map(),
    new Map(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.view!.book.uri, EDITION_URI_BH);
  assert.equal(result.view!.book.title, 'The Creative Act');
  assert.deepEqual(result.view!.book.authorNames, ['Rick Rubin']);
  assert.equal(result.view!.book.coverUrl, undefined);
});

test('resolveBookShelf: bookhive fallback titles only when the record has none', () => {
  const result = resolveBookShelf(makeBookhiveRow(), new Map(), new Map());
  assert.equal(result.ok, true);
  assert.equal(result.view!.book.title, 'Untitled');
  assert.equal(result.view!.book.authorNames, undefined);
});

test('resolveBookShelf: bookhive fallback uri falls back to the record uri', () => {
  const row = makeBookhiveRow({ hiveBookUri: null, title: 'No hive identity' });
  (row.value as Record<string, unknown>).hiveId = undefined;
  const result = resolveBookShelf(row, new Map(), new Map());
  assert.equal(result.ok, true);
  assert.equal(result.view!.book.uri, row.uri);
});

test('resolveBookShelf: a status-less bookhive record is owned, not shelved', () => {
  const row = makeBookhiveRow({ title: 'Review only' });
  (row.value as Record<string, unknown>).status = undefined;
  const result = resolveBookShelf(row, new Map(), new Map());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shelf-not-found');
});

test('resolveBookShelf: bookhive reading dates travel in metadata, not createdAt', () => {
  const bookMap = new Map([[EDITION_URI_BH, makeBookView(EDITION_URI_BH)]]);
  const result = resolveBookShelf(
    makeBookhiveRow({ startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-02-03T00:00:00.000Z' }),
    bookMap,
    new Map(),
  );
  assert.deepEqual(result.view!.metadata, {
    status: 'read',
    startedAt: '2026-01-02T00:00:00.000Z',
    finishedAt: '2026-02-03T00:00:00.000Z',
  });
  assert.equal(result.view!.createdAt, '2026-08-26T00:00:00.000Z');
});

test('resolveBookShelf: a hydrated bookhive edition wins on title and gains the record author only when empty', () => {
  const bookMap = new Map([[EDITION_URI_BH, makeBookView(EDITION_URI_BH, 'Catalog Title')]]);
  const result = resolveBookShelf(
    makeBookhiveRow({ title: 'Record Title', authors: 'Rick Rubin' }),
    bookMap,
    new Map(),
  );
  assert.equal(result.view!.book.title, 'Catalog Title');
  assert.deepEqual(result.view!.book.authorNames, ['Rick Rubin']);
});

test('resolveBookShelf: bookhive row without hiveBookUri still resolves through hiveId', () => {
  const bookMap = new Map([[EDITION_URI_BH, makeBookView(EDITION_URI_BH)]]);
  const result = resolveBookShelf(makeBookhiveRow({ hiveBookUri: null }), bookMap, new Map());
  assert.equal(result.ok, true);
  assert.equal(result.view!.book.uri, EDITION_URI_BH);
});

test('bookUriForRow: a bookhive row resolves to its mirrored edition', () => {
  // The hydration pass batches by this function, so a row it cannot place is
  // dropped before `resolveBookShelf` ever sees it. A bookhive rkey is a TID,
  // which the catalog-rkey derivation cannot read, so the branch is load-bearing.
  assert.equal(bookUriForRow(makeBookhiveRow()), EDITION_URI_BH);
});

test('bookUriForRow: a bookhive row without any hive identity has no book', () => {
  const row = makeBookhiveRow({ hiveBookUri: null });
  (row.value as Record<string, unknown>).hiveId = undefined;
  assert.equal(bookUriForRow(row), null);
});

test('bookUriForRow: a livtet row still reads its own strongRef first', () => {
  const row = makeShelvingRow({
    rkey: 'dune',
    bookRef: { uri: 'at://did:web:biblio.test/community.lexicon.book.edition/ol.OL1W' },
  });
  assert.equal(bookUriForRow(row), 'at://did:web:biblio.test/community.lexicon.book.edition/ol.OL1W');
});

// Reference unrelated constant to satisfy unused-import linters.
void SHELVING_URI;