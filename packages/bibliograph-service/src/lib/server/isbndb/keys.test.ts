import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isbndbEditionRkey,
  isbndbWorkRkey,
  isbndbPublisherRkey,
  isbndbEditionUri,
  isbndbWorkUri,
  isbnFromIsbndbRkey,
  isIsbndbRkey,
  isbndbIdentifierFromUri,
} from './keys';

test('isbndbEditionRkey: isbndb.{isbn13}', () => {
  assert.equal(isbndbEditionRkey('9780134093413'), 'isbndb.9780134093413');
});

test('isbndbEditionRkey strips hyphens before validating', () => {
  assert.equal(isbndbEditionRkey('978-0-13-409341-3'), 'isbndb.9780134093413');
});

test('isbndbWorkRkey mirrors edition rkey', () => {
  assert.equal(isbndbWorkRkey('9780134093413'), 'isbndb.9780134093413');
});

test('isbndbPublisherRkey mirrors edition rkey', () => {
  assert.equal(isbndbPublisherRkey('9780134093413'), 'isbndb.9780134093413');
});

test('isbn10 is accepted', () => {
  assert.equal(isbndbEditionRkey('0134093413'), 'isbndb.0134093413');
});

test('isbndbEditionUri: at://{PUBLISHER_DID}/community.lexicon.book.edition/isbndb.{isbn}', () => {
  const uri = isbndbEditionUri('9780134093413');
  assert.ok(uri.startsWith('at://'));
  assert.ok(uri.endsWith('/community.lexicon.book.edition/isbndb.9780134093413'));
});

test('isbndbWorkUri: at://{PUBLISHER_DID}/community.lexicon.book.work/isbndb.{isbn}', () => {
  const uri = isbndbWorkUri('9780134093413');
  assert.ok(uri.startsWith('at://'));
  assert.ok(uri.endsWith('/community.lexicon.book.work/isbndb.9780134093413'));
});

test('isbnFromIsbndbRkey round-trip', () => {
  assert.equal(isbnFromIsbndbRkey('isbndb.9780134093413'), '9780134093413');
});

test('isIsbndbRkey accepts isbndb. prefix, rejects ol./gb.', () => {
  assert.equal(isIsbndbRkey('isbndb.9780134093413'), true);
  assert.equal(isIsbndbRkey('ol.OL12345M'), false);
  assert.equal(isIsbndbRkey('gb.GhPSEAAAQBAJ'), false);
  assert.equal(isIsbndbRkey('isbndb.978013409341'), false);
});

test('isbnFromIsbndbRkey rejects non-isbndb', () => {
  assert.throws(() => isbnFromIsbndbRkey('ol.OL12345M'));
  assert.throws(() => isbnFromIsbndbRkey('isbndb.12345'));
});

test('isbndbEditionRkey rejects malformed ids', () => {
  assert.throws(() => isbndbEditionRkey('12345'));
  assert.throws(() => isbndbEditionRkey('abcdefghij'));
  assert.throws(() => isbndbEditionRkey(''));
});

test('isbndbIdentifierFromUri extracts isbn from ISBNDb URL', () => {
  assert.equal(isbndbIdentifierFromUri('https://api2.isbndb.com/book/9780134093413'), '9780134093413');
  assert.equal(isbndbIdentifierFromUri('https://api2.isbndb.com/book/978-0-13-409341-3'), '9780134093413');
  assert.equal(isbndbIdentifierFromUri('https://api2.isbndb.com/book/short'), null);
  assert.equal(isbndbIdentifierFromUri('https://other.com/book/9780134093413'), null);
});
