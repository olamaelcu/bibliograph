/**
 * The edge's cover cache reader: the path layout has to match the worker's
 * exactly (they are two copies of one rule), and the validator has to survive
 * what a browser actually sends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COVER_CACHE_CONTROL,
  cachedCoverSize,
  coverCachePath,
  coverEtag,
  normalizeIfNoneMatch,
  readCover
} from '../src/lib/server/covers/cache.ts';
// The worker's copy of the same rule. Importing it here is the assertion: two
// packages, one path, or the edge serves a 404 for bytes that are on disk.
import { coverCachePath as workerCoverCachePath } from '../../worker/lib/cover-cache.js';

const DIR = '/var/cache/bibliograph-covers';
const URIS = [
  'at://did:plc:abc/community.lexicon.media.book.edition/3abc',
  'at://did:web:biblio.example/community.lexicon.media.book.edition/3kz%2Fweird+name'
];

test('the path layout is identical in the worker and the edge', () => {
  for (const uri of URIS) {
    assert.equal(coverCachePath(DIR, uri), workerCoverCachePath(DIR, uri), uri);
  }
});

test('the path is two hex characters of fan-out over the URI digest', () => {
  const path = coverCachePath(DIR, URIS[0] as string);
  assert.match(path, new RegExp(`^${DIR}/[0-9a-f]{2}/[0-9a-f]{64}$`));
  assert.equal(path.split('/').at(-1)?.slice(0, 2), path.split('/').at(-2));
  assert.equal(coverCachePath(DIR, URIS[1] as string) === path, false);
});

test('the etag is a strong validator that moves with the byte size', () => {
  const etag = coverEtag(URIS[0] as string, 74_000);
  assert.match(etag, /^"[0-9a-f]{16}-74000"$/);
  assert.notEqual(etag, coverEtag(URIS[0] as string, 74_001));
  assert.notEqual(etag, coverEtag(URIS[1] as string, 74_000));
});

test('If-None-Match is normalized to a bare validator', () => {
  assert.equal(normalizeIfNoneMatch('W/"abc-1"'), '"abc-1"');
  assert.equal(normalizeIfNoneMatch(' "abc-1" '), '"abc-1"');
  assert.equal(normalizeIfNoneMatch('"other", "abc-1"'), '"other"');
  assert.equal(normalizeIfNoneMatch(null), null);
  assert.equal(normalizeIfNoneMatch(''), null);
  assert.equal(normalizeIfNoneMatch('W/'), null);
});

test('an immutable cache-control is what the route advertises', () => {
  assert.match(COVER_CACHE_CONTROL, /max-age=31536000/);
  assert.match(COVER_CACHE_CONTROL, /immutable/);
});

test('a missing file reads as null instead of throwing', async () => {
  assert.equal(await readCover(coverCachePath(DIR, URIS[0] as string)), null);
  assert.equal(await cachedCoverSize(DIR, URIS[0] as string), null);
});
