import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IDENTIFIERS,
  hasIsbn,
  isbnFromIdentifier,
  isbnIdentifier,
  isIsbnResource,
  mergeIsbnIdentifiers,
  normaliseIsbn,
} from './merge';
import type { Identifier } from '../search/types';

const OL_IDENTIFIER: Identifier = {
  uri: 'https://openlibrary.org/books/OL3292288M',
  resource: 'openlibrary',
};

test('isIsbnResource only accepts the three ISBN resources', () => {
  assert.equal(isIsbnResource('isbn'), true);
  assert.equal(isIsbnResource('isbn10'), true);
  assert.equal(isIsbnResource('isbn13'), true);
  assert.equal(isIsbnResource('openlibrary'), false);
  assert.equal(isIsbnResource('toString'), false);
});

test('normaliseIsbn keeps digits and a trailing X', () => {
  assert.equal(normaliseIsbn('978-1-4696-1288-1'), '9781469612881');
  assert.equal(normaliseIsbn(' 0-8044-2957-x '), '080442957X');
  assert.equal(normaliseIsbn('n/a'), '');
});

test('isbnFromIdentifier reads only `isbn:` uris on ISBN resources', () => {
  assert.equal(isbnFromIdentifier({ uri: 'isbn:9781469612881', resource: 'isbn13' }), '9781469612881');
  assert.equal(isbnFromIdentifier({ uri: 'isbn:1469612887', resource: 'isbn10' }), '1469612887');
  assert.equal(isbnFromIdentifier({ uri: 'urn:isbn:9781469612881', resource: 'isbn13' }), null);
  assert.equal(isbnFromIdentifier({ uri: 'isbn:123', resource: 'isbn13' }), null);
  assert.equal(isbnFromIdentifier(OL_IDENTIFIER), null);
});

test('hasIsbn sees through unrelated identifiers', () => {
  assert.equal(hasIsbn([OL_IDENTIFIER]), false);
  assert.equal(hasIsbn([]), false);
  assert.equal(hasIsbn(undefined), false);
  assert.equal(hasIsbn([OL_IDENTIFIER, { uri: 'isbn:9781469612881', resource: 'isbn13' }]), true);
});

test('isbnIdentifier picks the resource from the length', () => {
  assert.deepEqual(isbnIdentifier('978-1469612881'), { uri: 'isbn:9781469612881', resource: 'isbn13' });
  assert.deepEqual(isbnIdentifier('1469612887'), { uri: 'isbn:1469612887', resource: 'isbn10' });
  assert.equal(isbnIdentifier('12345'), null);
});

test('mergeIsbnIdentifiers appends without touching what is there', () => {
  const { identifiers, added } = mergeIsbnIdentifiers([OL_IDENTIFIER], ['9781469612881']);

  assert.deepEqual(added, ['9781469612881']);
  assert.deepEqual(identifiers[0], OL_IDENTIFIER);
  assert.deepEqual(identifiers[1], { uri: 'isbn:9781469612881', resource: 'isbn13' });
});

test('mergeIsbnIdentifiers puts ISBN-13 before ISBN-10', () => {
  const { identifiers } = mergeIsbnIdentifiers([], ['1469612887', '9781469612881']);
  assert.deepEqual(
    identifiers.map((ident) => ident.resource),
    ['isbn13', 'isbn10'],
  );
});

test('mergeIsbnIdentifiers collapses duplicates including hyphenated ones', () => {
  const { identifiers, added } = mergeIsbnIdentifiers(
    [{ uri: 'isbn:9781469612881', resource: 'isbn13' }],
    ['978-1-4696-1288-1', '9781469612881'],
  );

  assert.deepEqual(added, []);
  assert.equal(identifiers.length, 1);
});

test('mergeIsbnIdentifiers respects the lexicon cap', () => {
  const existing: Identifier[] = Array.from({ length: MAX_IDENTIFIERS - 1 }, (_, i) => ({
    uri: `https://example.org/${i}`,
    resource: 'custom',
  }));
  const { identifiers, added } = mergeIsbnIdentifiers(existing, ['9781469612881', '1469612887']);

  assert.equal(identifiers.length, MAX_IDENTIFIERS);
  assert.deepEqual(added, ['9781469612881']);
});

test('mergeIsbnIdentifiers ignores values that are not ISBNs', () => {
  const { added } = mergeIsbnIdentifiers([], ['not-an-isbn', '']);
  assert.deepEqual(added, []);
});
