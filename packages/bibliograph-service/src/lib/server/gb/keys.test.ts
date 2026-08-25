import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gbEditionRkey,
  gbWorkRkey,
  gbEditionUri,
  gbWorkUri,
  volumeIdFromGbRkey,
  isGbRkey,
  gbIdentifierFromUri,
} from './keys';

test('gbEditionRkey: gb.{volumeId}', () => {
  assert.equal(gbEditionRkey('GhPSEAAAQBAJ'), 'gb.GhPSEAAAQBAJ');
});

test('gbWorkRkey mirrors edition', () => {
  assert.equal(gbWorkRkey('GhPSEAAAQBAJ'), 'gb.GhPSEAAAQBAJ');
});

test('gbEditionUri: at://{PUBLISHER_DID}/community.lexicon.book.edition/gb.{vid}', () => {
  const uri = gbEditionUri('GhPSEAAAQBAJ');
  assert.ok(uri.startsWith('at://'));
  assert.ok(uri.endsWith('/community.lexicon.book.edition/gb.GhPSEAAAQBAJ'));
});

test('volumeIdFromGbRkey round-trip', () => {
  assert.equal(volumeIdFromGbRkey('gb.GhPSEAAAQBAJ'), 'GhPSEAAAQBAJ');
});

test('isGbRkey accepts gb. prefix, rejects ol.', () => {
  assert.equal(isGbRkey('gb.GhPSEAAAQBAJ'), true);
  assert.equal(isGbRkey('ol.OL12345M'), false);
  assert.equal(isGbRkey('gb.x'), false);
});

test('volumeIdFromGbRkey rejects non-gb', () => {
  assert.throws(() => volumeIdFromGbRkey('ol.OL12345M'));
  assert.throws(() => volumeIdFromGbRkey('gb.short'));
});

test('gbIdentifierFromUri extracts volume id from canonical GB URL', () => {
  assert.equal(gbIdentifierFromUri('https://books.google.com/books?id=GhPSEAAAQBAJ'), 'GhPSEAAAQBAJ');
  assert.equal(gbIdentifierFromUri('https://other.com/books?id=xxx'), null);
  assert.equal(gbIdentifierFromUri('https://books.google.com/books?id=short'), null);
});

test('gbEditionRkey rejects malformed ids', () => {
  assert.throws(() => gbEditionRkey('short'));
  assert.throws(() => gbEditionRkey('has spaces'));
  assert.throws(() => gbEditionRkey('a/b'));
});