import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRecentCursor, encodeRecentCursor } from './cursor';
import { compareShelfBooks } from './order';
import { SHELVING_COLLECTION } from './shelvers';
import type { NetOlamaelcuLivtetBiblioDefs } from '../lexicons/index.js';

const USER = 'did:plc:user' as const;
const SHELF_URI = `at://${USER}/net.olamaelcu.livtet.biblio.shelf/read`;

test('a recency cursor round-trips its exact instant and uri', () => {
  const uri = `at://${USER}/${SHELVING_COLLECTION}/ol.OL1M`;
  const sortKey = '2026-11-02T15:04:05.123Z';
  assert.deepEqual(decodeRecentCursor(encodeRecentCursor(sortKey, uri)), { sortKey, uri });
});

test('the sort key is carried verbatim, including a fraction the column stores', () => {
  const uri = `at://${USER}/${SHELVING_COLLECTION}/ol.OL1M`;
  // Re-serialising through `Date` would drop the microseconds and the resumed
  // page would compare keys that are not the column's.
  const sortKey = '2026-11-02T15:04:05.123456Z';
  assert.deepEqual(decodeRecentCursor(encodeRecentCursor(sortKey, uri)), { sortKey, uri });
});

test('a blank sort key is a real cursor for the undated tail', () => {
  const uri = `at://${USER}/${SHELVING_COLLECTION}/ol.OL1M`;
  assert.deepEqual(decodeRecentCursor(encodeRecentCursor('', uri)), { sortKey: '', uri });
});

test('cursors that are not ours are ignored rather than half-read', () => {
  assert.equal(decodeRecentCursor(undefined), undefined);
  assert.equal(decodeRecentCursor(''), undefined);
  assert.equal(decodeRecentCursor('42'), undefined);
  assert.equal(decodeRecentCursor('con:abc'), undefined);
  assert.equal(decodeRecentCursor(Buffer.from('{"t":"2026-11-02T00:00:00Z"}').toString('base64url')), undefined);
  assert.equal(decodeRecentCursor(Buffer.from('{"t":7,"u":"at://x"}').toString('base64url')), undefined);
  assert.equal(decodeRecentCursor(Buffer.from('{"t":"2026-11-02T00:00:00Z","u":""}').toString('base64url')), undefined);
});

function shelvingUri(rkey: string): `at://${string}` {
  return `at://${USER}/${SHELVING_COLLECTION}/${rkey}`;
}

function shelfBook(rkey: string, position?: number): NetOlamaelcuLivtetBiblioDefs.BookShelfView {
  return {
    uri: shelvingUri(rkey) as NetOlamaelcuLivtetBiblioDefs.BookShelfView['uri'],
    shelf: { uri: SHELF_URI as NetOlamaelcuLivtetBiblioDefs.ShelfView['uri'], name: 'Read' },
    book: {
      uri: `at://did:web:publisher/community.lexicon.book.edition/${rkey}` as NetOlamaelcuLivtetBiblioDefs.BookView['uri'],
      title: rkey,
    },
    metadata: position === undefined ? { status: 'read' } : { status: 'read', position },
    did: USER as NetOlamaelcuLivtetBiblioDefs.BookShelfView['did'],
  };
}

test('positioned books sort by position, unpositioned ones follow', () => {
  const books = [shelfBook('c'), shelfBook('a', 2), shelfBook('b', 1), shelfBook('d')];
  assert.deepEqual(books.slice().sort(compareShelfBooks).map((book) => book.uri), [
    shelvingUri('b'),
    shelvingUri('a'),
    shelvingUri('c'),
    shelvingUri('d'),
  ]);
});

test('equal and absent positions fall back to the uri so the order is stable', () => {
  const tied = [shelfBook('z', 3), shelfBook('y', 3), shelfBook('x', 3)];
  assert.deepEqual(tied.slice().sort(compareShelfBooks).map((book) => book.uri), [
    shelvingUri('x'),
    shelvingUri('y'),
    shelvingUri('z'),
  ]);
});
