import test from 'node:test';
import assert from 'node:assert/strict';
import { SHELVING_COLLECTION, collectShelverDids, shelvingRkeyFor } from './shelvers';

const BOOK = 'at://did:web:biblio.test/community.lexicon.book.edition/ol.OL1M';
const RKEY = 'ol.OL1M';

function shelvingUri(did: string, rkey = RKEY): string {
  return `at://${did}/${SHELVING_COLLECTION}/${rkey}`;
}

test('shelvingRkeyFor takes the last segment of the catalog book URI', () => {
  assert.equal(shelvingRkeyFor(BOOK), RKEY);
  assert.equal(shelvingRkeyFor('at://did:web:biblio.test/community.lexicon.book.edition/gb.IYeOAgAAQBAJ'), 'gb.IYeOAgAAQBAJ');
  assert.equal(shelvingRkeyFor('ol.OL1M'), '');
});

test('collectShelverDids reports each shelver once, in record order', () => {
  const dids = collectShelverDids(RKEY, [
    { uri: shelvingUri('did:plc:b') },
    { uri: shelvingUri('did:plc:a') },
    { uri: shelvingUri('did:plc:b') },
    { uri: shelvingUri('did:plc:c') },
  ]);
  assert.deepEqual(dids, ['did:plc:b', 'did:plc:a', 'did:plc:c']);
});

test('records carrying another rkey are not shelvers of this book', () => {
  const dids = collectShelverDids(RKEY, [
    { uri: shelvingUri('did:plc:kept') },
    { uri: shelvingUri('did:plc:other-book', 'ol.OL2M') },
    { uri: shelvingUri('did:plc:no-rkey-suffix', 'rk') },
  ]);
  assert.deepEqual(dids, ['did:plc:kept']);
});

test('records from another collection are dropped even when the rkey matches', () => {
  const dids = collectShelverDids(RKEY, [
    { uri: `at://did:plc:reviewer/net.olamaelcu.livtet.biblio.bookReview/${RKEY}` },
    { uri: shelvingUri('did:plc:shelver') },
  ]);
  assert.deepEqual(dids, ['did:plc:shelver']);
});

test('malformed or non-AT record URIs are dropped instead of inventing a DID', () => {
  const dids = collectShelverDids(RKEY, [
    { uri: '' },
    { uri: 'https://example.test/shelving' },
    { uri: `at:///${RKEY}` },
    { uri: `at://did:plc:x/${SHELVING_COLLECTION}/${RKEY}/extra` },
    { uri: shelvingUri('did:plc:shelver') },
  ]);
  assert.deepEqual(dids, ['did:plc:shelver']);
});

test('an empty rkey matches nothing, so a malformed book URI cannot list the network', () => {
  assert.deepEqual(collectShelverDids('', [{ uri: shelvingUri('did:plc:a', '') }]), []);
});
