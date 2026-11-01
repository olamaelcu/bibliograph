import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { enrichWithWikidata, olIdFromIdentifierUri } from './wikidata';
import { wikidataBreaker } from './breakers';
import type { EditionItem } from '../search/types';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => impl(String(url), init)) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function sparqlResponse(rows: Array<{ qid: string; olid: string; links?: number; viaf?: string; isni?: string }>) {
  return new Response(JSON.stringify({
    results: {
      bindings: rows.map((r) => ({
        item: { type: 'uri', value: `http://www.wikidata.org/entity/${r.qid}` },
        olid: { type: 'literal', value: r.olid },
        ...(r.links === undefined ? {} : { links: { type: 'literal', value: String(r.links) } }),
        ...(r.viaf === undefined ? {} : { viafId: { type: 'literal', value: r.viaf } }),
        ...(r.isni === undefined ? {} : { isniId: { type: 'literal', value: r.isni } }),
      })),
    },
  }), { headers: { 'content-type': 'application/sparql-results+json' } });
}

function olIdsIn(init?: RequestInit): string[] {
  const query = new URLSearchParams(String(init?.body)).get('query') ?? '';
  const values = /VALUES \?olid \{([^}]*)\}/.exec(query)?.[1] ?? '';
  return [...values.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

function edition(olid: string, uri = `https://openlibrary.org/works/${olid}`): EditionItem {
  return {
    uri: `at://did:web:x/community.lexicon.book.edition/ol.${olid}`,
    title: 'Test',
    identifiers: [{ uri, resource: 'openlibrary' }],
    contributors: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

test('olIdFromIdentifierUri only accepts real Open Library entity URIs', () => {
  assert.equal(olIdFromIdentifierUri('https://openlibrary.org/works/OL66554W'), 'OL66554W');
  assert.equal(olIdFromIdentifierUri('https://openlibrary.org/books/OL3292288M'), 'OL3292288M');
  assert.equal(olIdFromIdentifierUri('https://openlibrary.org/authors/OL23919A'), 'OL23919A');
  assert.equal(olIdFromIdentifierUri('https://openlibrary.org/works/OLnotanolidW'), undefined);
  assert.equal(olIdFromIdentifierUri('https://example.org/works/OL66554W'), undefined);
});

test('the most-linked Wikidata item wins when several claim one OLID', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async (url, init) => {
    assert.equal(url, 'https://query.wikidata.org/sparql');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(olIdsIn(init), ['OL1001W']);
    return sparqlResponse([
      { qid: 'Q900001', olid: 'OL1001W', links: 0 },
      { qid: 'Q900002', olid: 'OL1001W', links: 100 },
    ]);
  });
  try {
    const [out] = await enrichWithWikidata([edition('OL1001W')], log);
    assert.deepEqual(out?.identifiers, [
      { uri: 'https://openlibrary.org/works/OL1001W', resource: 'openlibrary' },
      { uri: 'https://www.wikidata.org/entity/Q900002', resource: 'wikidata' },
    ]);
  } finally { restore(); }
});

test('equal sitelink counts fall back to the lowest Q-number, deterministically', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async () => sparqlResponse([
    { qid: 'Q950070', olid: 'OL1002W', links: 7 },
    { qid: 'Q950010', olid: 'OL1002W', links: 7 },
    { qid: 'Q950030', olid: 'OL1002W', links: 7 },
  ]));
  try {
    const [out] = await enrichWithWikidata([edition('OL1002W')], log);
    assert.deepEqual(out?.identifiers[1], {
      uri: 'https://www.wikidata.org/entity/Q950010',
      resource: 'wikidata',
    });
  } finally { restore(); }
});

test('VIAF and ISNI accompany the Q-id when Wikidata holds them', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async () => sparqlResponse([
    { qid: 'Q960001', olid: 'OL1003A', links: 12, viaf: '116796842', isni: '0000 0001 2148 628X' },
  ]));
  try {
    const [out] = await enrichWithWikidata(
      [edition('OL1003A', 'https://openlibrary.org/authors/OL1003A')],
      log,
    );
    assert.deepEqual(out?.identifiers.slice(1), [
      { uri: 'https://www.wikidata.org/entity/Q960001', resource: 'wikidata' },
      { uri: 'https://viaf.org/viaf/116796842', resource: 'viaf' },
      { uri: 'https://isni.org/isni/000000012148628X', resource: 'isni' },
    ]);
  } finally { restore(); }
});

test('an unmatched OLID leaves the item exactly as it was', async () => {
  wikidataBreaker.recordSuccess();
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return sparqlResponse([]); });
  try {
    const input = edition('OL1004W');
    const out = await enrichWithWikidata([input], log);
    assert.equal(calls, 1, 'the lookup did happen');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], input);
  } finally { restore(); }
});

test('identifiers are never grown past the lexicon cap of 32', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async () => sparqlResponse([
    { qid: 'Q970001', olid: 'OL1005W', links: 3, viaf: '1', isni: '2' },
  ]));
  try {
    const input: EditionItem = {
      ...edition('OL1005W'),
      identifiers: [
        ...Array.from({ length: 30 }, (_, i) => ({ uri: `https://example.org/${i}`, resource: 'custom' })),
        { uri: 'https://openlibrary.org/works/OL1005W', resource: 'openlibrary' },
      ],
    };
    const [out] = await enrichWithWikidata([input], log);
    assert.equal(out?.identifiers.length, 32);
    assert.equal(out?.identifiers.at(-1)?.resource, 'wikidata');
  } finally { restore(); }
});

test('items already carrying a wikidata identifier are not looked up again', async () => {
  wikidataBreaker.recordSuccess();
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return sparqlResponse([]); });
  try {
    const already: EditionItem = {
      ...edition('OL1006W'),
      identifiers: [
        { uri: 'https://openlibrary.org/works/OL1006W', resource: 'openlibrary' },
        { uri: 'https://www.wikidata.org/entity/Q1', resource: 'wikidata' },
      ],
    };
    const out = await enrichWithWikidata([already], log);
    assert.equal(calls, 0);
    assert.deepEqual(out[0], already);
  } finally { restore(); }
});

test('more than 50 OLIDs are split across several SPARQL requests', async () => {
  wikidataBreaker.recordSuccess();
  const chunks: string[][] = [];
  const restore = stubFetch(async (_url, init) => {
    chunks.push(olIdsIn(init));
    return sparqlResponse([]);
  });
  try {
    const items = Array.from({ length: 120 }, (_, i) => edition(`OL${20_000_000 + i}W`));
    const out = await enrichWithWikidata(items, log);
    assert.equal(out.length, 120);
    assert.deepEqual(chunks.map((c) => c.length), [50, 50, 20]);
    assert.equal(new Set(chunks.flat()).size, 120, 'every OLID is queried exactly once');
  } finally { restore(); }
});

test('an endpoint failure degrades to the untouched items', async () => {
  wikidataBreaker.recordSuccess();
  let attempts = 0;
  const restore = stubFetch(async () => { attempts++; return new Response('boom', { status: 500 }); });
  try {
    const input = edition('OL1007W');
    const out = await enrichWithWikidata([input], log);
    assert.equal(attempts, 3, '5xx is retried before giving up');
    assert.deepEqual(out[0], input);
  } finally {
    wikidataBreaker.recordSuccess();
    restore();
  }
});
