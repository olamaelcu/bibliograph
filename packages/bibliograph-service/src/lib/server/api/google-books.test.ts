import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { enrichEditions } from './google-books.ts';
import type { EditionItem } from '../search/types.ts';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const baseItem: EditionItem = {
  title: 'Test',
  identifiers: [{ uri: 'isbn:9780123456789', resource: 'isbn13' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

test('enrichEditions writes description + coverImageUrl from Google Books', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const restore = stubFetch(async (url) => {
    assert.match(url, /googleapis\.com\/books\/v1\/volumes/);
    assert.match(url, /q=isbn:9780123456789/);
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
    const [out] = await enrichEditions([baseItem], log);
    assert.equal(out.description, 'A great book.');
    assert.equal(out.coverImageUrl, 'http://books.google.com/cover.jpg');
  } finally { restore(); }
});

test('enrichEditions leaves item unchanged when Google Books returns no match', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const restore = stubFetch(async () => new Response(JSON.stringify({ totalItems: 0 }), { headers: { 'content-type': 'application/json' } }));
  try {
    const [out] = await enrichEditions([baseItem], log);
    assert.equal(out.description, undefined);
    assert.equal(out.coverImageUrl, undefined);
  } finally { restore(); }
});

test('enrichEditions no-ops when GOOGLE_BOOKS_API_KEY is missing', async () => {
  delete process.env.GOOGLE_BOOKS_API_KEY;
  let called = false;
  const restore = stubFetch(async () => { called = true; return new Response('{}'); });
  try {
    const [out] = await enrichEditions([baseItem], log);
    assert.equal(out.description, undefined);
    assert.equal(called, false);
  } finally { restore(); }
});
