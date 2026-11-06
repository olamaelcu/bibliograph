import test from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { RecordRow } from '../db/schema';
import type { NetOlamaelcuLivtetBiblioDefs } from '../lexicons/index.js';
import {
  SHELF_ITEM_COLLECTION,
  bookUriForItemRow,
  buildShelfItemView,
  clampShelfItemLimit,
  isShelfItemOf,
  shelfItemConditions,
  shelfItemMetadataOf,
  shelfUriForItemRow,
} from './shelf-items.js';
import { shelfViewFromValue } from './shelf-view.js';

const USER = 'did:plc:reader';
const SHELF_URI = `at://${USER}/net.olamaelcu.livtet.biblio.shelf/3lxyzcustom`;
const OTHER_SHELF_URI = `at://${USER}/net.olamaelcu.livtet.biblio.shelf/3lxyzother`;
const BOOK_URI = 'at://did:web:biblio.test/community.lexicon.book.edition/gb.qzybEQAAQBAJ';
const ITEM_URI = `at://${USER}/net.olamaelcu.livtet.biblio.shelfItem/3lxyzitem`;

const dialect = new PgDialect();

/** The SQL and bound parameters drizzle would run for a condition. */
function compiled(condition: SQL) {
  const { sql, params } = dialect.sqlToQuery(condition);
  return { sql: sql.replace(/\s+/g, ' '), params };
}

function itemRow(value: Record<string, unknown> = {}): RecordRow {
  return {
    uri: ITEM_URI,
    cid: 'bafyplaceholder',
    did: USER,
    rkey: '3lxyzitem',
    collection: SHELF_ITEM_COLLECTION,
    value: value as RecordRow['value'],
    createdAt: new Date(),
    indexedAt: new Date(),
    recordCreatedAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  };
}

function shelfView(): NetOlamaelcuLivtetBiblioDefs.ShelfView {
  return shelfViewFromValue(SHELF_URI, {
    name: 'Cozy Fantasy',
    description: 'Low stakes, high comfort.',
    createdAt: '2026-11-01T10:00:00.000Z',
  });
}

function bookView(): NetOlamaelcuLivtetBiblioDefs.BookView {
  return {
    uri: BOOK_URI as NetOlamaelcuLivtetBiblioDefs.BookView['uri'],
    title: 'A Psalm for the Wild-Built',
    $type: 'net.olamaelcu.livtet.biblio.defs#bookView',
  };
}

// ─── mirror query ───────────────────────────────────────────────────────────

test('shelfItemConditions: reads the shelfItem collection for one shelf', () => {
  const { sql, params } = compiled(shelfItemConditions({ shelfUri: SHELF_URI }));

  assert.match(sql, /"records"\."collection" = \$\d+/);
  // The shelf is matched on the value, not the rkey: the rkey is only derived
  // from it, and a record written with another key still belongs on the shelf.
  assert.match(sql, /"records"\."value"->>'shelf' = \$\d+/);
  assert.deepEqual(params, [SHELF_ITEM_COLLECTION, SHELF_URI]);
});

test('shelfItemConditions: scoping to a repo adds the did predicate', () => {
  const { sql, params } = compiled(shelfItemConditions({ shelfUri: SHELF_URI, did: USER }));

  assert.match(sql, /"records"\."did" = \$\d+/);
  assert.deepEqual(params, [SHELF_ITEM_COLLECTION, SHELF_URI, USER]);
});

test('shelfItemConditions: another shelf never enters the same page', () => {
  const { sql, params } = compiled(shelfItemConditions({ shelfUri: SHELF_URI }));
  assert.doesNotMatch(sql, /3lxyzother/);
  assert.ok(!params.includes(OTHER_SHELF_URI));
});

// ─── limit ──────────────────────────────────────────────────────────────────

test('clampShelfItemLimit: default, floor and ceiling', () => {
  assert.equal(clampShelfItemLimit(undefined), 50);
  assert.equal(clampShelfItemLimit(25), 25);
  assert.equal(clampShelfItemLimit(0), 1);
  assert.equal(clampShelfItemLimit(-10), 1);
  assert.equal(clampShelfItemLimit(101), 100);
  assert.equal(clampShelfItemLimit(10_000), 100);
});

test('clampShelfItemLimit: a fractional or non-finite limit still yields an integer', () => {
  assert.equal(clampShelfItemLimit(5.9), 5);
  assert.equal(clampShelfItemLimit(Number.NaN), 50);
  assert.equal(clampShelfItemLimit(Number.POSITIVE_INFINITY), 50);
});

// ─── PDS fallback ───────────────────────────────────────────────────────────

test('isShelfItemOf: only records naming this shelf pass the scan', () => {
  assert.equal(isShelfItemOf({ shelf: SHELF_URI, book: { uri: BOOK_URI } }, SHELF_URI), true);
  assert.equal(isShelfItemOf({ shelf: OTHER_SHELF_URI, book: { uri: BOOK_URI } }, SHELF_URI), false);
  assert.equal(isShelfItemOf({ book: { uri: BOOK_URI } }, SHELF_URI), false);
  assert.equal(isShelfItemOf({ shelf: '' }, SHELF_URI), false);
  assert.equal(isShelfItemOf(null, SHELF_URI), false);
  assert.equal(isShelfItemOf('at://not-a-record', SHELF_URI), false);
});

test('shelfUriForItemRow: the record value, not the rkey, names the shelf', () => {
  assert.equal(shelfUriForItemRow(itemRow({ shelf: SHELF_URI })), SHELF_URI);
  assert.equal(shelfUriForItemRow(itemRow({})), null);
  assert.equal(shelfUriForItemRow(itemRow({ shelf: 7 })), null);
});

// ─── book ref ───────────────────────────────────────────────────────────────

test('bookUriForItemRow: reads the strongRef uri', () => {
  assert.equal(
    bookUriForItemRow(itemRow({ book: { uri: BOOK_URI, cid: 'bafybook' } })),
    BOOK_URI,
  );
});

test('bookUriForItemRow: a bare uri string is accepted, a missing book is not', () => {
  assert.equal(bookUriForItemRow(itemRow({ book: BOOK_URI })), BOOK_URI);
  assert.equal(bookUriForItemRow(itemRow({})), null);
  assert.equal(bookUriForItemRow(itemRow({ book: { cid: 'bafybook' } })), null);
});

// ─── metadata ───────────────────────────────────────────────────────────────

test('shelfItemMetadataOf: copies position, notes and emoji', () => {
  assert.deepEqual(
    shelfItemMetadataOf({ metadata: { position: 3, notes: 'reread in winter', emoji: '❄️' } }),
    { position: 3, notes: 'reread in winter', emoji: '❄️' },
  );
});

test('shelfItemMetadataOf: no metadata is an empty view, not undefined', () => {
  assert.deepEqual(shelfItemMetadataOf({ shelf: SHELF_URI, book: { uri: BOOK_URI } }), {});
  assert.deepEqual(shelfItemMetadataOf(null), {});
});

test('shelfItemMetadataOf: an invalid position is dropped, not forwarded', () => {
  for (const position of [0, -1, 1.5, '3', null]) {
    assert.equal(shelfItemMetadataOf({ metadata: { position } }).position, undefined);
  }
});

test('shelfItemMetadataOf: unknown metadata keys do not reach the view', () => {
  const metadata = shelfItemMetadataOf({ metadata: { position: 1, privateNote: 'secret' } });
  assert.deepEqual(Object.keys(metadata).sort(), ['emoji', 'notes', 'position']);
});

// ─── hydration ──────────────────────────────────────────────────────────────

test('buildShelfItemView: publishes uri, shelf, book, metadata, did and timestamps', () => {
  const view = buildShelfItemView(
    itemRow({
      shelf: SHELF_URI,
      book: { uri: BOOK_URI, cid: 'bafybook' },
      metadata: { position: 2, notes: 'signed copy', emoji: '📚' },
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-02T12:00:00.000Z',
    }),
    shelfView(),
    bookView(),
  );

  assert.equal(view.uri, ITEM_URI);
  assert.equal(view.$type, 'net.olamaelcu.livtet.biblio.defs#shelfItemView');
  assert.equal(view.did, USER);
  assert.equal(view.shelf.uri, SHELF_URI);
  // The shelf carries its description through the item, which is how a shelf
  // detail page renders without a second request.
  assert.equal(view.shelf.description, 'Low stakes, high comfort.');
  assert.equal(view.book.title, 'A Psalm for the Wild-Built');
  assert.deepEqual(view.metadata, { position: 2, notes: 'signed copy', emoji: '📚' });
  assert.equal(view.createdAt, '2026-11-01T10:00:00.000Z');
  assert.equal(view.updatedAt, '2026-11-02T12:00:00.000Z');
});

test('buildShelfItemView: an item without metadata or timestamps still validates', () => {
  const view = buildShelfItemView(
    itemRow({ shelf: SHELF_URI, book: { uri: BOOK_URI } }),
    shelfView(),
    bookView(),
  );

  assert.deepEqual(view.metadata, {});
  assert.equal(view.createdAt, undefined);
  assert.equal(view.updatedAt, undefined);
});
