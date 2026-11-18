import { expect, test } from 'vitest';

import { parseIdentifierParams } from '../src/lib/server/xrpc/identifiers.ts';

/**
 * The `identifiers` query parameter is the wire form of a resolver's exact
 * `(issuer, value)` list, so its parsing is the contract: a value may contain
 * colons, an issuer may not, and a malformed entry fails the call instead of
 * silently dropping a pair.
 */

test('each repeated parameter is one issuer:value pair', () => {
  expect(parseIdentifierParams(['isbn13:9780441478125', 'isni:0000000121032683'])).toEqual([
      { issuer: 'isbn13', value: '9780441478125' },
      { issuer: 'isni', value: '0000000121032683' }
    ]);
});

test('the split is on the first colon, so a value keeps its own colons', () => {
  expect(parseIdentifierParams(['wikidata:Q42', 'custom:ns:value'])).toEqual([
    { issuer: 'wikidata', value: 'Q42' },
    { issuer: 'custom', value: 'ns:value' }
  ]);
});

test('duplicate pairs collapse to one lookup', () => {
  expect(parseIdentifierParams(['viaf:123', 'viaf:123', 'viaf:124'])).toEqual([
      { issuer: 'viaf', value: '123' },
      { issuer: 'viaf', value: '124' }
    ]);
});

test('no parameters is an empty list, not a failure', () => {
  expect(parseIdentifierParams([])).toEqual([]);
});

test('a malformed entry fails the whole call', () => {
  for (const bad of ['isbn13', ':9780441478125', 'isbn13:', '']) {
    expect(parseIdentifierParams(['viaf:123', bad]), `${JSON.stringify(bad)} is malformed`).toBe(null);
  }
});

test('issuer and value are compared exactly, without trimming', () => {
  expect(parseIdentifierParams([' viaf:123'])).toEqual([
    { issuer: ' viaf', value: '123' }
  ]);
});
