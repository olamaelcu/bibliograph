/**
 * The edge's cover cache reader: the path layout has to match the worker's
 * exactly (they are two copies of one rule), and the validator has to survive
 * what a browser actually sends.
 */

import { expect, test } from 'vitest';

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
    expect(coverCachePath(DIR, uri), uri).toBe(workerCoverCachePath(DIR, uri));
  }
});

test('the path is two hex characters of fan-out over the URI digest', () => {
  const path = coverCachePath(DIR, URIS[0] as string);
  expect(path).toMatch(new RegExp(`^${DIR}/[0-9a-f]{2}/[0-9a-f]{64}$`));
  expect(path.split('/').at(-1)?.slice(0, 2)).toBe(path.split('/').at(-2));
  expect(coverCachePath(DIR, URIS[1] as string) === path).toBe(false);
});

test('the etag is a strong validator that moves with the byte size', () => {
  const etag = coverEtag(URIS[0] as string, 74_000);
  expect(etag).toMatch(/^"[0-9a-f]{16}-74000"$/);
  expect(etag).not.toBe(coverEtag(URIS[0] as string, 74_001));
  expect(etag).not.toBe(coverEtag(URIS[1] as string, 74_000));
});

test('If-None-Match is normalized to a bare validator', () => {
  expect(normalizeIfNoneMatch('W/"abc-1"')).toBe('"abc-1"');
  expect(normalizeIfNoneMatch(' "abc-1" ')).toBe('"abc-1"');
  expect(normalizeIfNoneMatch('"other", "abc-1"')).toBe('"other"');
  expect(normalizeIfNoneMatch(null)).toBe(null);
  expect(normalizeIfNoneMatch('')).toBe(null);
  expect(normalizeIfNoneMatch('W/')).toBe(null);
});

test('an immutable cache-control is what the route advertises', () => {
  expect(COVER_CACHE_CONTROL).toMatch(/max-age=31536000/);
  expect(COVER_CACHE_CONTROL).toMatch(/immutable/);
});

test('a missing file reads as null instead of throwing', async () => {
  expect(await readCover(coverCachePath(DIR, URIS[0] as string))).toBe(null);
  expect(await cachedCoverSize(DIR, URIS[0] as string)).toBe(null);
});
