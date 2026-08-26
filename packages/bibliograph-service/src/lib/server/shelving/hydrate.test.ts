import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
const EDITION_URI_OL = `at://${PUBLISHER_DID}/community.lexicon.book.edition/ol.OL32984650M`;

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

test('catalogEditionUriFromRkey maps ol.<OLID>M to catalog edition URI', () => {
  assert.equal(
    catalogEditionUriFromRkey('ol.OL32984650M'),
    EDITION_URI_OL,
  );
});

test('catalogEditionUriFromRkey returns null for invalid gb rkey', () => {
  // gb. is too short to pass GB_VOLUME_RE (min 8 chars).
  assert.equal(catalogEditionUriFromRkey('gb.bad'), null);
});

test('catalogEditionUriFromRkey returns null for non-edition ol rkey', () => {
  // Work rkey (ol.W...) and contributor rkey (ol.A...) are not editions.
  assert.equal(catalogEditionUriFromRkey('ol.W66554W'), null);
  assert.equal(catalogEditionUriFromRkey('ol.A12345A'), null);
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

test('resolveBookShelf: explicit book.ref.uri resolves when in bookMap', () => {
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

test('resolveBookShelf: empty book.ref falls back to rkey-derived URI', () => {
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

test('resolveBookShelf: empty book.ref with ol. rkey falls back', () => {
  const row = makeShelvingRow({
    rkey: 'ol.OL32984650M',
    bookRef: { uri: '' },
  });
  const bookMap = new Map([[EDITION_URI_OL, makeBookView(EDITION_URI_OL, 'OL Book')]]);
  const result = resolveBookShelf(row, bookMap, new Map());
  assert.equal(result.ok, true);
  assert.equal(result.view!.book.uri, EDITION_URI_OL);
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

// Reference unrelated constant to satisfy unused-import linters.
void SHELVING_URI;