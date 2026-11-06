import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IDENTIFIERS,
  hasIsbn,
  isbnFromIdentifier,
  isbnIdentifier,
  mergeIsbnIdentifiers,
  normaliseIsbn,
} from './merge';
import { isbn13FromAny, providerIdentifier } from '../identifiers';
import type { Identifier } from '../search/types';

const OL_IDENTIFIER: Identifier = providerIdentifier(
  'openlibrary',
  'https://openlibrary.org/books/OL3292288M',
);

test('normaliseIsbn keeps digits and a trailing X', () => {
  assert.equal(normaliseIsbn('978-1-4696-1288-1'), '9781469612881');
  assert.equal(normaliseIsbn(' 0-8044-2957-x '), '080442957X');
  assert.equal(normaliseIsbn('n/a'), '');
});

test('isbnFromIdentifier reads only canonical ISBN-13 values on `isbn` identifiers', () => {
  assert.equal(isbnFromIdentifier({ type: 'isbn', value: '9781469612881' }), '9781469612881');
  // An ISBN-10 is not representable: the lexicon requires ISBN-13 on write.
  assert.equal(isbnFromIdentifier({ type: 'isbn', value: '1469612887' }), null);
  assert.equal(isbnFromIdentifier({ type: 'isbn', value: 'urn:isbn:9781469612881' }), null);
  assert.equal(isbnFromIdentifier({ type: 'isbn', value: '123' }), null);
  assert.equal(isbnFromIdentifier(OL_IDENTIFIER), null);
});

test('hasIsbn sees through unrelated identifiers', () => {
  assert.equal(hasIsbn([OL_IDENTIFIER]), false);
  assert.equal(hasIsbn([]), false);
  assert.equal(hasIsbn(undefined), false);
  assert.equal(hasIsbn([OL_IDENTIFIER, { type: 'isbn', value: '9781469612881' }]), true);
});

test('isbnIdentifier always yields one canonical ISBN-13', () => {
  assert.deepEqual(isbnIdentifier('978-1469612881'), { type: 'isbn', value: '9781469612881' });
  assert.deepEqual(isbnIdentifier('1469612887'), { type: 'isbn', value: isbn13FromAny('1469612887') });
  assert.equal(isbnIdentifier('12345'), null);
});

test('mergeIsbnIdentifiers appends without touching what is there', () => {
  const { identifiers, added } = mergeIsbnIdentifiers([OL_IDENTIFIER], ['9781469612881']);

  assert.deepEqual(added, ['9781469612881']);
  assert.deepEqual(identifiers[0], OL_IDENTIFIER);
  assert.deepEqual(identifiers[1], { type: 'isbn', value: '9781469612881' });
});

test('mergeIsbnIdentifiers collapses duplicates including hyphenated ones', () => {
  const { identifiers, added } = mergeIsbnIdentifiers(
    [{ type: 'isbn', value: '9781469612881' }],
    ['978-1-4696-1288-1', '9781469612881'],
  );

  assert.deepEqual(added, []);
  assert.equal(identifiers.length, 1);
});

test('mergeIsbnIdentifiers respects the lexicon cap', () => {
  const existing: Identifier[] = Array.from({ length: MAX_IDENTIFIERS - 1 }, (_, i) => ({
    type: 'example.org',
    value: String(i),
  }));
  const { identifiers, added } = mergeIsbnIdentifiers(existing, ['9781469612881', '1469612887']);

  assert.equal(identifiers.length, MAX_IDENTIFIERS);
  assert.deepEqual(added, ['9781469612881']);
});

test('mergeIsbnIdentifiers ignores values that are not ISBNs', () => {
  const { added } = mergeIsbnIdentifiers([], ['not-an-isbn', '']);
  assert.deepEqual(added, []);
});
