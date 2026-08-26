import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { enrichEditions, searchEditions, getBookByIsbn } from './isbndb';
import { isbndbBreaker } from './breakers';
import { db } from '../db';
import { contributors } from '../db/schema';
import type { EditionItem } from '../search/types';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => impl(String(url), init)) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function resetBreaker() {
  isbndbBreaker.recordSuccess();
}

const baseItem: EditionItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/isbndb.9780123456789',
  title: 'Test',
  identifiers: [{ uri: 'isbn:9780123456789', resource: 'isbn13' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

test('enrichEditions writes description + coverImageUrl from ISBNDb bulk', async () => {
  resetBreaker();
  process.env.ISBNDB_API_KEY = 'k';
  const restore = stubFetch(async (url, init) => {
    assert.match(url, /api2\.isbndb\.com\/books$/);
    assert.equal(init?.method, 'POST');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, 'k');
    const body = JSON.parse(String(init?.body)) as { isbns: string[] };
    assert.deepEqual(body.isbns, ['9780123456789']);
    return new Response(JSON.stringify({
      total: 1,
      data: [{
        title: 'Test',
        isbn13: '9780123456789',
        isbn10: '0123456789',
        synopsis: 'A great book.',
        image: 'http://covers.isbndb.com/cover.jpg',
        date_published: '2023',
      }],
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const [out] = await enrichEditions([baseItem], log);
    assert.ok(out);
    assert.equal(out.description, 'A great book.');
    assert.equal(out.coverImageUrl, 'https://covers.isbndb.com/cover.jpg');
  } finally { restore(); }
});

test('enrichEditions leaves item unchanged when ISBNDb returns no match', async () => {
  resetBreaker();
  process.env.ISBNDB_API_KEY = 'k';
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ total: 0, data: [] }), { headers: { 'content-type': 'application/json' } }),
  );
  try {
    const [out] = await enrichEditions([baseItem], log);
    assert.ok(out);
    assert.equal(out.description, undefined);
    assert.equal(out.coverImageUrl, undefined);
  } finally { restore(); }
});

test('enrichEditions no-ops when ISBNDB_API_KEY is missing', async () => {
  resetBreaker();
  delete process.env.ISBNDB_API_KEY;
  let called = false;
  const restore = stubFetch(async () => { called = true; return new Response('{}'); });
  try {
    const [out] = await enrichEditions([baseItem], log);
    assert.ok(out);
    assert.equal(out.description, undefined);
    assert.equal(called, false);
  } finally { restore(); }
});

test('searchEditions fetches /book/{isbn} for ISBN q', async () => {
  resetBreaker();
  process.env.ISBNDB_API_KEY = 'k';
  const restore = stubFetch(async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, 'k');
    assert.match(url, /api2\.isbndb\.com\/book\/9780134093413$/);
    return new Response(JSON.stringify({
      book: {
        title: 'The Pragmatic Programmer',
        isbn13: '9780134093413',
        date_published: '2019',
        synopsis: 'From journeyman to master.',
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await searchEditions({ q: '9780134093413', limit: 10 }, log);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.title, 'The Pragmatic Programmer');
    assert.equal(result.items[0]?.publishedYear, 2019);
    assert.equal(result.items[0]?.identifiers.find((i) => i.resource === 'isbn13')?.uri, 'isbn:9780134093413');
  } finally { restore(); }
});

test('searchEditions strips ISBN hyphens', async () => {
  resetBreaker();
  process.env.ISBNDB_API_KEY = 'k';
  const restore = stubFetch(async (url) => {
    assert.match(url, /\/book\/9780134093413$/);
    return new Response(JSON.stringify({ book: { title: 'X', isbn13: '9780134093413' } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await searchEditions({ q: '978-0-13-409341-3', limit: 10 }, log);
    assert.equal(result.items.length, 1);
  } finally { restore(); }
});

test('searchEditions rejects non-ISBN query with degraded', async () => {
  resetBreaker();
  process.env.ISBNDB_API_KEY = 'k';
  let called = false;
  const restore = stubFetch(async () => { called = true; return new Response('{}'); });
  try {
    const result = await searchEditions({ q: 'the great gatsby', limit: 10 }, log);
    assert.equal(result.items.length, 0);
    assert.equal(result.degraded?.reason, 'non_isbn_query');
    assert.equal(called, false);
  } finally { restore(); }
});

test('searchEditions degraded when ISBNDB_API_KEY missing', async () => {
  resetBreaker();
  delete process.env.ISBNDB_API_KEY;
  const restore = stubFetch(async () => { throw new Error('should not be called'); });
  try {
    const result = await searchEditions({ q: '9780134093413', limit: 10 }, log);
    assert.equal(result.items.length, 0);
    assert.equal(result.degraded?.reason, 'missing_api_key');
  } finally { restore(); }
});

test('searchEditions retries on 429 then succeeds', async () => {
  resetBreaker();
  process.env.ISBNDB_API_KEY = 'k';
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    if (calls === 1) {
      return new Response('{"message":"too many"}', {
        status: 429,
        headers: { 'content-type': 'application/json', ratelimit: '"rate";r=0;t=0' },
      });
    }
    return new Response(JSON.stringify({ book: { title: 'X', isbn13: '9780134093413' } }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const result = await searchEditions({ q: '9780134093413', limit: 10 }, log);
    assert.ok(calls >= 2, `expected retry, got ${calls} calls`);
    assert.equal(result.items.length, 1);
  } finally { restore(); }
});

test('getBookByIsbn returns null when ISBN invalid', async () => {
  resetBreaker();
  process.env.ISBNDB_API_KEY = 'k';
  const result = await getBookByIsbn('not-an-isbn', log);
  assert.equal(result, null);
});

test('getBookByIsbn returns null when ISBNDB_API_KEY missing', async () => {
  resetBreaker();
  delete process.env.ISBNDB_API_KEY;
  const result = await getBookByIsbn('9780134093413', log);
  assert.equal(result, null);
});

test('searchEditions populates contributors from b.authors', async () => {
  resetBreaker();
  process.env.ISBNDB_API_KEY = 'k';
  const AUTHOR = 'ISBNdb Test Author Populated';
  await db.delete(contributors).where(eq(contributors.name, AUTHOR));
  const restore = stubFetch(async () => new Response(JSON.stringify({
    book: {
      title: 'ISBNdb Test Book',
      isbn13: '9780134093413',
      authors: [AUTHOR],
    },
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const result = await searchEditions({ q: '9780134093413', limit: 10 }, log);
    assert.equal(result.items.length, 1);
    const c = result.items[0]?.contributors ?? [];
    assert.equal(c.length, 1, 'expected one populated contributor');
    assert.equal(c[0]?.role, 'author');
    assert.match(c[0]?.subject.uri ?? '', /\/isbndb\.a-isbndb-test-author-populated$/);
  } finally {
    restore();
    await db.delete(contributors).where(eq(contributors.name, AUTHOR));
  }
});
