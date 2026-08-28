import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { searchEditions, searchWorks, getEditionByRkey, getWorkByRkey } from './open-library';
import { db } from '../db';
import { contributors } from '../db/schema';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, _init?: RequestInit) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function contributorUriFor(olid: string): string {
  return `at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.A${olid.slice(2)}`;
}

async function deleteContributor(olid: string): Promise<void> {
  await db.delete(contributors).where(eq(contributors.uri, contributorUriFor(olid)));
}

test('searchEditions hits OpenLibrary with type=edition', async () => {
  let captured = '';
  const restore = stubFetch(async (url) => {
    captured = url;
    return jsonResponse({
      numFound: 1,
      docs: [{ key: '/books/OL12345M', title: 'Test', isbn: ['9780123456789'] }],
    });
  });
  try {
    const result = await searchEditions({ q: 'test', limit: 20 }, log);
    assert.match(captured, /openlibrary\.org\/search\.json/);
    assert.match(captured, /type=edition/);
    assert.match(captured, /q=test/);
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.title, 'Test');
    assert.deepEqual(result.items[0]?.identifiers[0], { uri: 'https://openlibrary.org/books/OL12345M', resource: 'openlibrary' });
  } finally { restore(); }
});

test('searchEditions forwards OpenLibrary nextPage to cursor', async () => {
  const restore = stubFetch(async (_url) => jsonResponse({
    numFound: 5, page: 1, docs: [{ key: '/books/OL1M', title: 'A' }],
  }));
  try {
    const result = await searchEditions({ q: 'x', limit: 1 }, log);
    assert.equal(result.cursor, undefined, 'cursor is deferred to the orchestrator');
  } finally { restore(); }
});

test('searchEditions propagates 4xx as error log + empty result', async () => {
  const restore = stubFetch(async (_url) => new Response('bad', { status: 500 }));
  try {
    const result = await searchEditions({ q: 'x', limit: 1 }, log);
    assert.equal(result.items.length, 0);
  } finally { restore(); }
});

test('searchEditions: lang[] translates to OL language= (MARC, comma-joined)', async () => {
  let captured = '';
  const restore = stubFetch(async (url) => {
    captured = url;
    return jsonResponse({ numFound: 0, docs: [] });
  });
  try {
    await searchEditions({ q: 'x', limit: 1, lang: ['en-US', 'fr'] }, log);
    assert.match(captured, /language=eng%2Cfre/);
  } finally { restore(); }
});

test('searchEditions: unmapped lang[] tags omit the language= param (fail-closed)', async () => {
  let captured = '';
  const restore = stubFetch(async (url) => {
    captured = url;
    return jsonResponse({ numFound: 0, docs: [] });
  });
  try {
    await searchEditions({ q: 'x', limit: 1, lang: ['xx'] }, log);
    assert.doesNotMatch(captured, /language=/);
  } finally { restore(); }
});

test('searchEditions populates contributors from author_key', async () => {
  const olid = 'OL7777777A';
  const restore = stubFetch(async (url) => {
    if (url.includes(`/authors/${olid}`)) {
      return jsonResponse({ key: `/authors/${olid}`, name: 'Search Edition Author', alternate_names: [] });
    }
    if (url.includes('/search.json')) {
      return jsonResponse({
        numFound: 1,
        docs: [{
          key: '/books/OL7777777M',
          title: 'Test Edition',
          author_key: [olid],
          author_name: ['Search Edition Author'],
        }],
      });
    }
    return new Response('not found', { status: 404 });
  });
  await deleteContributor(olid);
  try {
    const result = await searchEditions({ q: 'test', limit: 20 }, log);
    assert.equal(result.items.length, 1);
    const c = result.items[0]?.contributors ?? [];
    assert.equal(c.length, 1, 'expected one populated contributor');
    assert.equal(c[0]?.role, 'author');
    assert.equal(c[0]?.subject.uri, contributorUriFor(olid));
    assert.match(c[0]?.subject.cid ?? '', /^bafy/);
  } finally {
    restore();
    await deleteContributor(olid);
  }
});

test('searchWorks populates contributors from authors[].author.key', async () => {
  const olid = 'OL7777778A';
  const restore = stubFetch(async (url) => {
    if (url.includes(`/authors/${olid}`)) {
      return jsonResponse({ key: `/authors/${olid}`, name: 'Search Work Author', alternate_names: [] });
    }
    if (url.includes('/search.json')) {
      return jsonResponse({
        numFound: 1,
        docs: [{
          key: '/works/OL7777778W',
          title: 'Test Work',
          authors: [{ author: { key: `/authors/${olid}` }, type: { key: '/type/author_role' } }],
        }],
      });
    }
    return new Response('not found', { status: 404 });
  });
  await deleteContributor(olid);
  try {
    const result = await searchWorks({ q: 'work', limit: 20 }, log);
    assert.equal(result.items.length, 1);
    const c = result.items[0]?.contributors ?? [];
    assert.equal(c.length, 1, 'expected one populated contributor');
    assert.equal(c[0]?.role, 'author');
    assert.equal(c[0]?.subject.uri, contributorUriFor(olid));
  } finally {
    restore();
    await deleteContributor(olid);
  }
});

test('getEditionByRkey populates contributors from authors array', async () => {
  const olid = 'OL7777779A';
  const restore = stubFetch(async (url) => {
    if (url.includes(`/authors/${olid}`)) {
      return jsonResponse({ key: `/authors/${olid}`, name: 'Direct Edition Author', alternate_names: [] });
    }
    if (url.includes('/books/OL7777779M')) {
      return jsonResponse({
        key: '/books/OL7777779M',
        title: 'Direct Edition',
        authors: [{ key: `/authors/${olid}` }],
      });
    }
    return new Response('not found', { status: 404 });
  });
  await deleteContributor(olid);
  try {
    const item = await getEditionByRkey('ol.OL7777779M', log);
    assert.ok(item, 'expected edition item');
    const c = item?.contributors ?? [];
    assert.equal(c.length, 1, 'expected one populated contributor');
    assert.equal(c[0]?.role, 'author');
    assert.equal(c[0]?.subject.uri, contributorUriFor(olid));
  } finally {
    restore();
    await deleteContributor(olid);
  }
});

test('getWorkByRkey populates contributors from authors[].author.key', async () => {
  const olid = 'OL7777780A';
  const restore = stubFetch(async (url) => {
    if (url.includes(`/authors/${olid}`)) {
      return jsonResponse({ key: `/authors/${olid}`, name: 'Direct Work Author', alternate_names: [] });
    }
    if (url.includes('/works/OL7777780W')) {
      return jsonResponse({
        key: '/works/OL7777780W',
        title: 'Direct Work',
        authors: [{ author: { key: `/authors/${olid}` } }],
      });
    }
    return new Response('not found', { status: 404 });
  });
  await deleteContributor(olid);
  try {
    const item = await getWorkByRkey('ol.W7777780W', log);
    assert.ok(item, 'expected work item');
    const c = item?.contributors ?? [];
    assert.equal(c.length, 1, 'expected one populated contributor');
    assert.equal(c[0]?.role, 'author');
    assert.equal(c[0]?.subject.uri, contributorUriFor(olid));
  } finally {
    restore();
    await deleteContributor(olid);
  }
});
