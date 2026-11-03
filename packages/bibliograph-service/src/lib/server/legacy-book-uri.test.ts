import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalEditionRkey,
  canonicalEditionUri,
  isCanonicalEditionUri,
  rkeyOfUri,
} from './legacy-book-uri';

const DID = 'did:web:biblio.test';
const CURRENT = `at://${DID}/community.lexicon.book.edition`;

test('canonicalEditionRkey maps every dash spelling onto the catalog key', () => {
  assert.equal(canonicalEditionRkey('gb-b9AOEAAAQBAJ'), 'gb.b9AOEAAAQBAJ');
  assert.equal(canonicalEditionRkey('ol-OL1W'), 'ol.OL1W');
  assert.equal(canonicalEditionRkey('bh-bk_abc123'), 'bh.bk_abc123');
  assert.equal(canonicalEditionRkey('isbn-9780593135204'), 'isbndb.9780593135204');
  assert.equal(canonicalEditionRkey('isbndb-9780593135204'), 'isbndb.9780593135204');
});

test('canonicalEditionRkey leaves a canonical key alone, so callers need no guard', () => {
  assert.equal(canonicalEditionRkey('gb.b9AOEAAAQBAJ'), 'gb.b9AOEAAAQBAJ');
  assert.equal(canonicalEditionRkey(`${CURRENT}/ol.OL1W`), 'ol.OL1W');
});

test('canonicalEditionRkey reads the key out of a retired uri whatever its did or collection', () => {
  assert.equal(
    canonicalEditionRkey('at://did:web:localhost/net.olamaelcu.livtet.biblio.book/gb-b9AOEAAAQBAJ'),
    'gb.b9AOEAAAQBAJ',
  );
});

test('canonicalEditionRkey refuses keys it cannot spell', () => {
  assert.equal(canonicalEditionRkey(''), null);
  assert.equal(canonicalEditionRkey('3mst4pvyu7m2f'), null);
  assert.equal(canonicalEditionRkey('work-OL1W'), null);
  assert.equal(canonicalEditionRkey('gb-'), null);
  assert.equal(canonicalEditionRkey('gb.a/b'), null);
});

test('canonicalEditionUri builds the published uri from either spelling', () => {
  assert.equal(canonicalEditionUri('gb-b9AOEAAAQBAJ', DID), `${CURRENT}/gb.b9AOEAAAQBAJ`);
  assert.equal(canonicalEditionUri(`${CURRENT}/gb.b9AOEAAAQBAJ`, DID), `${CURRENT}/gb.b9AOEAAAQBAJ`);
  assert.equal(canonicalEditionUri('work-1', DID), null);
});

test('isCanonicalEditionUri separates the three retired shapes from the live one', () => {
  assert.equal(isCanonicalEditionUri(`${CURRENT}/ol.OL1W`, DID), true);
  // wrong DID (development era)
  assert.equal(isCanonicalEditionUri(`at://did:web:localhost/community.lexicon.book.edition/ol.OL1W`, DID), false);
  // pre-`biblio` collection
  assert.equal(isCanonicalEditionUri(`at://${DID}/net.olamaelcu.livtet.biblio.book/ol.OL1W`, DID), false);
  // dash-separated key
  assert.equal(isCanonicalEditionUri(`${CURRENT}/gb-b9AOEAAAQBAJ`, DID), false);
});

test('rkeyOfUri takes the last segment and passes a bare key through', () => {
  assert.equal(rkeyOfUri(`${CURRENT}/ol.OL1W`), 'ol.OL1W');
  assert.equal(rkeyOfUri('ol.OL1W'), 'ol.OL1W');
  assert.equal(rkeyOfUri('   '), null);
});
