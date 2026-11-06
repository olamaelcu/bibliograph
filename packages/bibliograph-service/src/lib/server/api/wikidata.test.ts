import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { enrichWithWikidata } from './wikidata';
import { wikidataBreaker } from './breakers';
import type { EditionItem } from '../search/types';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => impl(String(url), init)) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function sparqlResponse(rows: Array<{ qid: string; viaf?: string; isni?: string }>) {
  return new Response(JSON.stringify({
    results: {
      bindings: rows.map((r) => ({
        item: { type: 'uri', value: `http://www.wikidata.org/entity/${r.qid}` },
        ...(r.viaf === undefined ? {} : { viafId: { type: 'literal', value: r.viaf } }),
        ...(r.isni === undefined ? {} : { isniId: { type: 'literal', value: r.isni } }),
      })),
    },
  }), { headers: { 'content-type': 'application/sparql-results+json' } });
}

function qidsIn(init?: RequestInit): string[] {
  const query = new URLSearchParams(String(init?.body)).get('query') ?? '';
  const values = /VALUES \?item \{([^}]*)\}/.exec(query)?.[1] ?? '';
  return [...values.matchAll(/wd:(Q\d+)/g)].map((m) => m[1] as string);
}

function edition(qid: string): EditionItem {
  return {
    uri: `at://did:web:x/community.lexicon.book.edition/q.${qid}`,
    title: 'Test',
    identifiers: [{ uri: `https://www.wikidata.org/entity/${qid}`, resource: 'wikidata' }],
    contributors: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

test('VIAF and ISNI are appended to an item that carries the Q-id', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async (url, init) => {
    assert.equal(url, 'https://query.wikidata.org/sparql');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(qidsIn(init), ['Q960001']);
    return sparqlResponse([{ qid: 'Q960001', viaf: '116796842', isni: '0000 0001 2148 628X' }]);
  });
  try {
    const [out] = await enrichWithWikidata([edition('Q960001')], log);
    assert.deepEqual(out?.identifiers, [
      { uri: 'https://www.wikidata.org/entity/Q960001', resource: 'wikidata' },
      { uri: 'https://viaf.org/viaf/116796842', resource: 'viaf' },
      { uri: 'https://isni.org/isni/000000012148628X', resource: 'isni' },
    ]);
  } finally { restore(); }
});

test('only VIAF is appended when Wikidata holds no ISNI', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async () => sparqlResponse([{ qid: 'Q960002', viaf: '106392' }]));
  try {
    const [out] = await enrichWithWikidata([edition('Q960002')], log);
    assert.deepEqual(out?.identifiers.slice(1), [{ uri: 'https://viaf.org/viaf/106392', resource: 'viaf' }]);
  } finally { restore(); }
});

test('items without a wikidata identifier are not looked up', async () => {
  wikidataBreaker.recordSuccess();
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return sparqlResponse([]); });
  try {
    const input: EditionItem = {
      ...edition('Q960003'),
      identifiers: [{ uri: 'isbn:9781469612881', resource: 'isbn13' }],
    };
    const out = await enrichWithWikidata([input], log);
    assert.equal(calls, 0);
    assert.deepEqual(out[0], input);
  } finally { restore(); }
});

test('an unmatched Q-id leaves the item exactly as it was', async () => {
  wikidataBreaker.recordSuccess();
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return sparqlResponse([]); });
  try {
    const input = edition('Q960004');
    const out = await enrichWithWikidata([input], log);
    assert.equal(calls, 1, 'the lookup did happen');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], input);
  } finally { restore(); }
});

test('a Q-id with neither VIAF nor ISNI adds nothing', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async () => sparqlResponse([{ qid: 'Q960005' }]));
  try {
    const input = edition('Q960005');
    const [out] = await enrichWithWikidata([input], log);
    assert.deepEqual(out, input);
  } finally { restore(); }
});

test('identifiers are never grown past the lexicon cap of 32', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async () => sparqlResponse([{ qid: 'Q970001', viaf: '1', isni: '2' }]));
  try {
    const input: EditionItem = {
      ...edition('Q970001'),
      identifiers: [
        ...Array.from({ length: 30 }, (_, i) => ({ uri: `https://example.org/${i}`, resource: 'custom' })),
        { uri: 'https://www.wikidata.org/entity/Q970001', resource: 'wikidata' },
      ],
    };
    const [out] = await enrichWithWikidata([input], log);
    assert.equal(out?.identifiers.length, 32);
    assert.equal(out?.identifiers.at(-1)?.resource, 'viaf', 'the second authority no longer fits');
  } finally { restore(); }
});

test('one Q-id shared by several items is queried once', async () => {
  wikidataBreaker.recordSuccess();
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return sparqlResponse([{ qid: 'Q980001', viaf: '7' }]); });
  try {
    const out = await enrichWithWikidata([edition('Q980001'), edition('Q980001')], log);
    assert.equal(calls, 1);
    assert.deepEqual(out.map((item) => item.identifiers.at(-1)?.resource), ['viaf', 'viaf']);
  } finally { restore(); }
});

test('more than 50 Q-ids are split across several SPARQL requests', async () => {
  wikidataBreaker.recordSuccess();
  const chunks: string[][] = [];
  const restore = stubFetch(async (_url, init) => {
    chunks.push(qidsIn(init));
    return sparqlResponse([]);
  });
  try {
    const items = Array.from({ length: 120 }, (_, i) => edition(`Q${90_000_000 + i}`));
    const out = await enrichWithWikidata(items, log);
    assert.equal(out.length, 120);
    assert.deepEqual(chunks.map((c) => c.length), [50, 50, 20]);
    assert.equal(new Set(chunks.flat()).size, 120, 'every Q-id is queried exactly once');
  } finally { restore(); }
});

test('an endpoint failure degrades to the untouched items', async () => {
  wikidataBreaker.recordSuccess();
  let attempts = 0;
  const restore = stubFetch(async () => { attempts++; return new Response('boom', { status: 500 }); });
  try {
    const input = edition('Q990001');
    const out = await enrichWithWikidata([input], log);
    assert.equal(attempts, 3, '5xx is retried before giving up');
    assert.deepEqual(out[0], input);
  } finally {
    wikidataBreaker.recordSuccess();
    restore();
  }
});
