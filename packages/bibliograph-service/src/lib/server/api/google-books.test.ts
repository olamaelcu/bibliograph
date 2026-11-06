import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { enrichEditions, getEditionByVolumeId, searchEditions } from './google-books';
import { db } from '../db';
import { contributors } from '../db/schema';
import type { EditionItem } from '../search/types';
import { isbnIdentifier } from '../identifiers';

const log = pino({ level: 'silent' });

// The response cache is durable and shared, so fixed inputs would let a previous
// run — or a suite running in another process — answer the fetch these tests are
// asserting on. Every input is therefore unique per process run, which keeps the
// tests independent without any table-wide cleanup racing other test files.
const RUN = Math.floor(Math.random() * 1e9).toString(36);
const uniq = (tag: string): string => `${tag}-${RUN}`;
const isbnFor = (tag: string): string => {
  const digits = `${RUN}${tag}`.replace(/\D/g, '').padEnd(10, '0').slice(0, 10);
  return `978${digits}`;
};

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function itemWithIsbn(isbn: string): EditionItem {
  const identifier = isbnIdentifier(isbn);
  if (!identifier) throw new Error(`not an ISBN: ${isbn}`);
  return {
    uri: `at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.Test${isbn}`,
    title: 'Test',
    identifiers: [identifier],
    contributors: [],
    createdAt: new Date().toISOString(),
  };
}

async function cleanupAuthor(name: string): Promise<void> {
  await db.delete(contributors).where(eq(contributors.name, name));
}

test('enrichEditions writes description + coverImageUrl from Google Books', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const isbn = isbnFor('1');
  const restore = stubFetch(async (url) => {
    assert.match(url, /googleapis\.com\/books\/v1\/volumes/);
    assert.match(url, new RegExp(`q=isbn:${isbn}`));
    assert.match(url, /key=k/);
    return new Response(JSON.stringify({
      items: [{
        volumeInfo: {
          description: 'A great book.',
          imageLinks: { thumbnail: 'http://books.google.com/cover.jpg' },
        },
      }],
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const [out] = await enrichEditions([itemWithIsbn(isbn)], log);
    assert.ok(out);
    assert.equal(out.description, 'A great book.');
    assert.equal(out.coverImageUrl, 'https://books.google.com/cover.jpg');
  } finally { restore(); }
});

test('enrichEditions leaves item unchanged when Google Books returns no match', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const restore = stubFetch(async () => new Response(JSON.stringify({ totalItems: 0 }), { headers: { 'content-type': 'application/json' } }));
  try {
    const [out] = await enrichEditions([itemWithIsbn(isbnFor('2'))], log);
    assert.ok(out);
    assert.equal(out.description, undefined);
    assert.equal(out.coverImageUrl, undefined);
  } finally { restore(); }
});

test('enrichEditions no-ops when GOOGLE_BOOKS_API_KEY is missing', async () => {
  delete process.env.GOOGLE_BOOKS_API_KEY;
  let called = false;
  const restore = stubFetch(async () => { called = true; return new Response('{}'); });
  try {
    const [out] = await enrichEditions([itemWithIsbn(isbnFor('3'))], log);
    assert.ok(out);
    assert.equal(out.description, undefined);
    assert.equal(called, false);
  } finally { restore(); }
});

test('searchEditions populates contributors from volumeInfo.authors', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const AUTHOR = 'Gb Test Author Populated';
  await cleanupAuthor(AUTHOR);
  const restore = stubFetch(async () => new Response(JSON.stringify({
    totalItems: 1,
    items: [{
      id: 'gbVolume123',
      volumeInfo: {
        title: 'GB Test Book',
        authors: [AUTHOR],
      },
    }],
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const result = await searchEditions({ q: uniq('gb contributors'), limit: 10 }, log);
    assert.equal(result.items.length, 1);
    const c = result.items[0]?.contributors ?? [];
    assert.equal(c.length, 1, 'expected one populated contributor');
    assert.equal(c[0]?.role, 'author');
    assert.match(c[0]?.subject.uri ?? '', /\/gb\.a-gb-test-author-populated$/);
  } finally {
    restore();
    await cleanupAuthor(AUTHOR);
  }
});

test('searchEditions: single-tag lang sets langRestrict=ISO 639-1', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  let captured = '';
  const restore = stubFetch(async (url) => {
    captured = url;
    return new Response(JSON.stringify({ totalItems: 0 }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    await searchEditions({ q: uniq('lang single'), limit: 1, lang: ['fr-CA'] }, log);
    assert.match(captured, /langRestrict=fr/);
  } finally { restore(); }
});

test('searchEditions: multi-tag lang omits langRestrict (GB returns nothing on multi-tag)', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  let captured = '';
  const restore = stubFetch(async (url) => {
    captured = url;
    return new Response(JSON.stringify({ totalItems: 0 }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    await searchEditions({ q: uniq('lang multi'), limit: 1, lang: ['en', 'fr'] }, log);
    assert.ok(captured, 'the query must reach upstream, not a cache entry');
    assert.doesNotMatch(captured, /langRestrict=/);
  } finally { restore(); }
});

test('searchEditions: unmapped single-tag lang omits langRestrict (fail-closed)', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  let captured = '';
  const restore = stubFetch(async (url) => {
    captured = url;
    return new Response(JSON.stringify({ totalItems: 0 }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    await searchEditions({ q: uniq('lang unmapped'), limit: 1, lang: ['xx'] }, log);
    assert.ok(captured, 'the query must reach upstream, not a cache entry');
    assert.doesNotMatch(captured, /langRestrict=/);
  } finally { restore(); }
});

// ─── Response cache ─────────────────────────────────────────────────────────
// These protect the GB quota: what matters is not that a value came back, but
// that the second identical call did not spend a request.

function countingFetch(body: unknown, status = 200): { restore: () => void; calls: () => number } {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return { restore, calls: () => calls };
}

test('searchEditions: an identical second query is served from the cache', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const q = { q: uniq('cache repeat'), limit: 5 };
  const upstream = countingFetch({
    totalItems: 1,
    items: [{ id: 'gbCacheVolume1', volumeInfo: { title: 'Cached Title' } }],
  });
  try {
    const first = await searchEditions(q, log);
    const second = await searchEditions(q, log);
    assert.equal(upstream.calls(), 1, 'second identical query must not reach upstream');
    assert.equal(first.items.length, 1);
    assert.deepEqual(second.items.map((i) => i.uri), first.items.map((i) => i.uri));
    assert.equal(second.items[0]?.title, 'Cached Title');
    assert.equal(second.total, first.total);
    assert.equal(second.cursor, first.cursor);
  } finally { upstream.restore(); }
});

test('searchEditions: a different query is a different cache entry', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const upstream = countingFetch({ totalItems: 0 });
  try {
    await searchEditions({ q: uniq('cache distinct a'), limit: 5 }, log);
    await searchEditions({ q: uniq('cache distinct b'), limit: 5 }, log);
    assert.equal(upstream.calls(), 2);
  } finally { upstream.restore(); }
});

test('getEditionByVolumeId: a 404 is remembered and not re-queried', async () => {
  const volumeId = `missingVolume404${RUN}`.replace(/[^A-Za-z0-9_-]/g, '');
  const upstream = countingFetch({ error: { message: 'Volume not found' } }, 404);
  try {
    const first = await getEditionByVolumeId(volumeId, log);
    const second = await getEditionByVolumeId(volumeId, log);
    assert.equal(first, null);
    assert.equal(second, null);
    assert.equal(upstream.calls(), 1, 'a remembered 404 must not spend another request');
  } finally { upstream.restore(); }
});

test('getEditionByVolumeId: a transient failure is not cached', async () => {
  // A 5xx is retried by withRetry, so assert the shape that matters instead of a
  // fetch count: the deliberate second call must still reach upstream.
  const volumeId = `transientVolume503${RUN}`.replace(/[^A-Za-z0-9_-]/g, '');
  const upstream = countingFetch({ error: { message: 'backend error' } }, 503);
  try {
    await getEditionByVolumeId(volumeId, log);
    const afterFirst = upstream.calls();
    await getEditionByVolumeId(volumeId, log);
    assert.ok(upstream.calls() > afterFirst, 'transient failures must not be replayed from cache');
  } finally { upstream.restore(); }
});
