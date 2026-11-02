import test from 'node:test';
import assert from 'node:assert/strict';
import { bookUriFromValue } from './book-ref';

const EDITION = 'at://did:web:biblio.test/community.lexicon.book.edition/ol.OL9M';
const OTHER_EDITION = 'at://did:web:biblio.test/community.lexicon.book.edition/isbndb.9780241364901';

test('the lexicon shape (`book.uri`) is read first', () => {
  assert.equal(bookUriFromValue({ book: { uri: EDITION, cid: 'bafyref' } }), EDITION);
});

test('a strongRef wins over a stale ref on the same record', () => {
  assert.equal(bookUriFromValue({ book: { uri: EDITION, ref: OTHER_EDITION } }), EDITION);
});

test('the legacy expanded-ref shape is read', () => {
  // Production still writes `book: { ref, title }`; 2,822 shelving rows carry it.
  assert.equal(bookUriFromValue({ book: { ref: EDITION, title: 'Girl, Woman, Other' } }), EDITION);
});

test('a bare at-uri book is read', () => {
  assert.equal(bookUriFromValue({ book: EDITION }), EDITION);
});

test('a ref that never named an edition is refused so the rkey fallback survives', () => {
  // Real data: did:web:localhost/net.olamaelcu.livtet.biblio.book/gb-b9AOEAAAQBAJ
  assert.equal(
    bookUriFromValue({ book: { ref: 'at://did:web:localhost/net.olamaelcu.livtet.biblio.book/gb-b9AOEAAAQBAJ' } }),
    null,
  );
  assert.equal(bookUriFromValue({ book: 'at://did:web:localhost/net.olamaelcu.livtet.biblio.book/x' }), null);
});

test('nothing to read gives null instead of an empty string', () => {
  assert.equal(bookUriFromValue(null), null);
  assert.equal(bookUriFromValue({}), null);
  assert.equal(bookUriFromValue({ book: {} }), null);
  assert.equal(bookUriFromValue({ book: '' }), null);
  assert.equal(bookUriFromValue({ book: 42 }), null);
  assert.equal(bookUriFromValue('at://did:web:x/community.lexicon.book.edition/y'), null);
});
