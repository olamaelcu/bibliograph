import test from 'node:test';
import assert from 'node:assert/strict';

import { parseIdentifierParams } from '../src/lib/server/xrpc/identifiers.ts';

/**
 * The `identifiers` query parameter is the wire form of a resolver's exact
 * `(issuer, value)` list, so its parsing is the contract: a value may contain
 * colons, an issuer may not, and a malformed entry fails the call instead of
 * silently dropping a pair.
 */

test('each repeated parameter is one issuer:value pair', () => {
  assert.deepEqual(
    parseIdentifierParams(['isbn13:9780441478125', 'isni:0000000121032683']),
    [
      { issuer: 'isbn13', value: '9780441478125' },
      { issuer: 'isni', value: '0000000121032683' }
    ]
  );
});

test('the split is on the first colon, so a value keeps its own colons', () => {
  assert.deepEqual(parseIdentifierParams(['wikidata:Q42', 'custom:ns:value']), [
    { issuer: 'wikidata', value: 'Q42' },
    { issuer: 'custom', value: 'ns:value' }
  ]);
});

test('duplicate pairs collapse to one lookup', () => {
  assert.deepEqual(
    parseIdentifierParams(['viaf:123', 'viaf:123', 'viaf:124']),
    [
      { issuer: 'viaf', value: '123' },
      { issuer: 'viaf', value: '124' }
    ]
  );
});

test('no parameters is an empty list, not a failure', () => {
  assert.deepEqual(parseIdentifierParams([]), []);
});

test('a malformed entry fails the whole call', () => {
  for (const bad of ['isbn13', ':9780441478125', 'isbn13:', '']) {
    assert.equal(parseIdentifierParams(['viaf:123', bad]), null, `${JSON.stringify(bad)} is malformed`);
  }
});

test('issuer and value are compared exactly, without trimming', () => {
  assert.deepEqual(parseIdentifierParams([' viaf:123']), [
    { issuer: ' viaf', value: '123' }
  ]);
});
