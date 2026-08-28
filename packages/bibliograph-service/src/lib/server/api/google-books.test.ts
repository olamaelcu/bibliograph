import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { enrichEditions, searchEditions } from './google-books';
import { db } from '../db';
import { contributors } from '../db/schema';
import type { EditionItem } from '../search/types';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const baseItem: EditionItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.Test123',
  title: 'Test',
  identifiers: [{ uri: 'isbn:9780123456789', resource: 'isbn13' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

async function cleanupAuthor(name: string): Promise<void> {
  await db.delete(contributors).where(eq(contributors.name, name));
}

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
    assert.ok(out);
    assert.equal(out.description, 'A great book.');
    assert.equal(out.coverImageUrl, 'https://books.google.com/cover.jpg');
  } finally { restore(); }
});

test('enrichEditions leaves item unchanged when Google Books returns no match', async () => {
  process.env.GOOGLE_BOOKS_API_KEY = 'k';
  const restore = stubFetch(async () => new Response(JSON.stringify({ totalItems: 0 }), { headers: { 'content-type': 'application/json' } }));
  try {
    const [out] = await enrichEditions([baseItem], log);
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
    const [out] = await enrichEditions([baseItem], log);
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
    const result = await searchEditions({ q: 'gb test', limit: 10 }, log);
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
    await searchEditions({ q: 'x', limit: 1, lang: ['fr-CA'] }, log);
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
    await searchEditions({ q: 'x', limit: 1, lang: ['en', 'fr'] }, log);
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
    await searchEditions({ q: 'x', limit: 1, lang: ['xx'] }, log);
    assert.doesNotMatch(captured, /langRestrict=/);
  } finally { restore(); }
});
