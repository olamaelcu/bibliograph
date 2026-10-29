import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKHIVE_DID,
  bhEditionRkey,
  bhEditionUri,
  bhWorkRkey,
  bookhiveCatalogUri,
  goodreadsUri,
  hiveIdFromBhRkey,
  hiveIdFromCatalogUri,
  isBhRkey,
  isHiveId,
} from './keys';

const HIVE_ID = 'bk_Wf9C5GP9iEGH6hqNNtwW';

test('bhEditionRkey: bh.{hiveId}', () => {
  assert.equal(bhEditionRkey(HIVE_ID), `bh.${HIVE_ID}`);
});

test('bhWorkRkey mirrors edition', () => {
  assert.equal(bhWorkRkey(HIVE_ID), bhEditionRkey(HIVE_ID));
});

test('bhEditionUri: at://{publisher}/community.lexicon.book.edition/bh.{hiveId}', () => {
  assert.ok(bhEditionUri(HIVE_ID).endsWith(`/community.lexicon.book.edition/bh.${HIVE_ID}`));
});

test('isHiveId accepts hive ids and rejects junk', () => {
  assert.equal(isHiveId(HIVE_ID), true);
  assert.equal(isHiveId('bk_zzpdK0fMgbLQYdzPhxwf'), true);
  assert.equal(isHiveId('bk_'), false);
  assert.equal(isHiveId('bk.short'), false);
  assert.equal(isHiveId(''), false);
  assert.equal(isHiveId('OL12345M'), false);
  assert.equal(isHiveId('../escape'), false);
});

test('bhEditionRkey rejects malformed hive ids', () => {
  assert.throws(() => bhEditionRkey('bk_'));
  assert.throws(() => bhEditionRkey('bk.dotted.id'));
  assert.throws(() => bhEditionRkey(''));
});

test('isBhRkey accepts bh. prefix only, rejects other families', () => {
  assert.equal(isBhRkey(`bh.${HIVE_ID}`), true);
  assert.equal(isBhRkey('ol.OL12345M'), false);
  assert.equal(isBhRkey('gb.GhPSEAAAQBAJ'), false);
  assert.equal(isBhRkey('isbndb.9780134093413'), false);
  assert.equal(isBhRkey('bh.'), false);
});

test('hiveIdFromBhRkey round-trips bhEditionRkey', () => {
  assert.equal(hiveIdFromBhRkey(bhEditionRkey(HIVE_ID)), HIVE_ID);
  assert.throws(() => hiveIdFromBhRkey(`ol.${HIVE_ID}`));
  assert.throws(() => hiveIdFromBhRkey('bh.'));
});

test('bookhiveCatalogUri points at the Bookhive record', () => {
  assert.equal(
    bookhiveCatalogUri(HIVE_ID),
    `at://${BOOKHIVE_DID}/buzz.bookhive.catalogBook/${HIVE_ID}`,
  );
});

test('hiveIdFromCatalogUri is the inverse of bookhiveCatalogUri', () => {
  assert.equal(hiveIdFromCatalogUri(bookhiveCatalogUri(HIVE_ID)), HIVE_ID);
  assert.equal(
    hiveIdFromCatalogUri('at://did:plc:other/buzz.bookhive.catalogBook/bk_Wf9C5GP9iEGH6hqNNtwW'),
    null,
  );
  assert.equal(hiveIdFromCatalogUri(`at://${BOOKHIVE_DID}/buzz.bookhive.book/3lct6cguexs2p`), null);
  assert.equal(hiveIdFromCatalogUri('https://bookhive.buzz/book/bk_123'), null);
});

test('goodreadsUri', () => {
  assert.equal(goodreadsUri('60965426'), 'https://www.goodreads.com/book/show/60965426');
});
