import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogBookToEditionItem,
  parseCatalogBook,
  splitAuthors,
} from './catalog';
import { BOOKHIVE_DID, bhEditionUri } from './keys';

const HIVE_ID = 'bk_zzpdK0fMgbLQYdzPhxwf';

// Shape observed on did:plc:enu2j5xjlqsjaylv3du4myh4 (Bookhive's PDS).
const RECORD = {
  $type: 'buzz.bookhive.catalogBook',
  id: HIVE_ID,
  title: 'Dune',
  authors: 'Frank Herbert',
  cover: 'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1.jpg',
  rating: 3090,
  source: 'Goodreads',
  sourceId: '53780375',
  createdAt: '2024-06-01T00:00:00.000Z',
};

test('parseCatalogBook keeps the fields an edition can use', () => {
  const rec = parseCatalogBook(RECORD);
  assert.ok(rec);
  assert.equal(rec.id, HIVE_ID);
  assert.equal(rec.title, 'Dune');
  assert.equal(rec.authors, 'Frank Herbert');
  assert.equal(rec.sourceId, '53780375');
});

test('parseCatalogBook rejects records that cannot produce an edition', () => {
  assert.equal(parseCatalogBook(null), null);
  assert.equal(parseCatalogBook({}), null);
  assert.equal(parseCatalogBook({ ...RECORD, title: '' }), null);
  assert.equal(parseCatalogBook({ ...RECORD, title: '   ' }), null);
  assert.equal(parseCatalogBook({ ...RECORD, id: 'not a hive id' }), null);
  assert.equal(parseCatalogBook({ ...RECORD, id: undefined }), null);
});

test('parseCatalogBook falls back to thumbnail when cover is absent', () => {
  const { cover: _cover, ...rest } = RECORD;
  const rec = parseCatalogBook({ ...rest, thumbnail: 'https://example.test/t.jpg' });
  assert.equal(rec?.cover, 'https://example.test/t.jpg');
});

test('parseCatalogBook drops non-numeric ratings instead of coercing', () => {
  assert.equal(parseCatalogBook({ ...RECORD, rating: '3090' })?.rating, undefined);
  assert.equal(parseCatalogBook({ ...RECORD, rating: 3090 })?.rating, 3090);
});

test('splitAuthors handles the free-form author string', () => {
  assert.deepEqual(splitAuthors('Frank Herbert'), ['Frank Herbert']);
  assert.deepEqual(splitAuthors('Brian Herbert, Kevin J. Anderson'), ['Brian Herbert', 'Kevin J. Anderson']);
  assert.deepEqual(splitAuthors('Ursula K. Le Guin and Neil Gaiman'), ['Ursula K. Le Guin', 'Neil Gaiman']);
  assert.deepEqual(splitAuthors('  '), []);
  assert.deepEqual(splitAuthors(undefined), []);
});

test('catalogBookToEditionItem keys the edition bh.{hiveId} with a bookhive identifier', () => {
  const rec = parseCatalogBook(RECORD)!;
  const item = catalogBookToEditionItem(rec)!;
  assert.equal(item.uri, bhEditionUri(HIVE_ID));
  assert.equal(item.title, 'Dune');
  assert.equal(item.coverImageUrl, RECORD.cover);
  assert.equal(item.createdAt, RECORD.createdAt);
  assert.deepEqual(item.contributors, []);
  assert.deepEqual(item.identifiers, [
    { uri: `at://${BOOKHIVE_DID}/buzz.bookhive.catalogBook/${HIVE_ID}`, resource: 'bookhive' },
    { uri: 'https://www.goodreads.com/book/show/53780375', resource: 'goodreads' },
  ]);
});

test('catalogBookToEditionItem keeps resolved contributions as given', () => {
  const rec = parseCatalogBook(RECORD)!;
  const contribution = { subject: { uri: 'at://did:plc:x/community.lexicon.book.contributor/ol.A1', cid: 'bafy1' }, role: 'author' };
  const item = catalogBookToEditionItem(rec, [contribution])!;
  assert.deepEqual(item.contributors, [contribution]);
});

test('catalogBookToEditionItem omits goodreads identifier for other sources', () => {
  const rec = parseCatalogBook({ ...RECORD, source: 'OpenLibrary', sourceId: 'OL1W' })!;
  const item = catalogBookToEditionItem(rec)!;
  assert.deepEqual(item.identifiers, [
    { uri: `at://${BOOKHIVE_DID}/buzz.bookhive.catalogBook/${HIVE_ID}`, resource: 'bookhive' },
  ]);
});

test('catalogBookToEditionItem needs a usable timestamp', () => {
  const rec = parseCatalogBook({ ...RECORD, createdAt: undefined })!;
  assert.equal(catalogBookToEditionItem(rec), null);
  const bad = parseCatalogBook({ ...RECORD, createdAt: 'not-a-date' })!;
  assert.equal(catalogBookToEditionItem(bad), null);
  const viaUpdate = parseCatalogBook({ ...RECORD, createdAt: undefined, updatedAt: '2025-01-02T03:04:05.000Z' })!;
  assert.equal(catalogBookToEditionItem(viaUpdate)?.createdAt, '2025-01-02T03:04:05.000Z');
});
