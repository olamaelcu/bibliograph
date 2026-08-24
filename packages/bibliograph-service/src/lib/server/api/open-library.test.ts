import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { searchEditions } from './open-library.ts';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, _init?: RequestInit) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test('searchEditions hits OpenLibrary with type=edition', async () => {
  let captured = '';
  const restore = stubFetch(async (url) => {
    captured = url;
    return new Response(JSON.stringify({
      numFound: 1,
      docs: [{ key: '/books/OL12345M', title: 'Test', isbn: ['9780123456789'] }],
    }), { headers: { 'content-type': 'application/json' } });
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
  const restore = stubFetch(async (_url) => new Response(JSON.stringify({
    numFound: 5, page: 1, docs: [{ key: '/books/OL1M', title: 'A' }],
  }), { headers: { 'content-type': 'application/json' } }));
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