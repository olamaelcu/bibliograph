import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogUriForMirroredRecord } from './pending-editions';
import { SHELVING_COLLECTION } from './shelvers';

const EDITION = 'at://did:web:biblio.test/community.lexicon.book.edition/ol.OL9M';
const HIVE_ID = 'bk_Wf9C5GP9iEGH6hqNNtwW';
const BH_EDITION = `at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/bh.${HIVE_ID}`;
const HIVE_URI = `at://did:plc:enu2j5xjlqsjaylv3du4myh4/buzz.bookhive.catalogBook/${HIVE_ID}`;

test('a bookShelving record with a strongRef book asks for that edition', () => {
  const uri = catalogUriForMirroredRecord(SHELVING_COLLECTION, 'ol.OL9M', {
    shelf: 'at://did:plc:user/net.olamaelcu.livtet.biblio.shelf/read',
    book: { uri: EDITION, cid: 'bafyref' },
  });
  assert.equal(uri, EDITION);
});

test('a bare string book is read the same as a strongRef', () => {
  const uri = catalogUriForMirroredRecord(SHELVING_COLLECTION, 'anything', { book: EDITION });
  assert.equal(uri, EDITION);
});

test('a record that predates the book ref falls back to its rkey', () => {
  const uri = catalogUriForMirroredRecord(SHELVING_COLLECTION, 'ol.OL9M', { shelf: 'at://did:plc:user/x/read' });
  assert.equal(uri, 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.OL9M');
});

test('a bookShelving rkey no provider owns asks for nothing', () => {
  assert.equal(catalogUriForMirroredRecord(SHELVING_COLLECTION, 'not-an-edition-rkey', {}), null);
});

test('a Bookhive record with a reading status asks for its catalog edition', () => {
  const uri = catalogUriForMirroredRecord('buzz.bookhive.book', 'self', {
    hiveBookUri: HIVE_URI,
    status: 'buzz.bookhive.defs#finished',
  });
  assert.equal(uri, BH_EDITION);
});

test('a Bookhive record that only rates a book is not shelving', () => {
  const uri = catalogUriForMirroredRecord('buzz.bookhive.book', 'self', {
    hiveBookUri: HIVE_URI,
    stars: 8,
  });
  assert.equal(uri, null);
});

test('reviews and unknown collections ask for nothing', () => {
  assert.equal(
    catalogUriForMirroredRecord('net.olamaelcu.livtet.bookReview', 'rev', { book: EDITION }),
    null,
  );
  assert.equal(catalogUriForMirroredRecord('net.olamaelcu.livtet.biblio.shelf', 'read', { name: 'Read' }), null);
});
