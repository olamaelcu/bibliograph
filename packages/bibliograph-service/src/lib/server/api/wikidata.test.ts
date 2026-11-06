import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { enrichWithWikidata } from './wikidata';
import { wikidataBreaker } from './breakers';
import type { EditionItem } from '../search/types';
import { providerIdentifier } from '../identifiers';

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
    uri: `at://did:web:x/community.lexicon.book.edition/wd.${qid}`,
    title: 'Test',
    identifiers: [providerIdentifier('wikidata', `https://www.wikidata.org/entity/${qid}`)],
    contributors: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

test('VIAF and ISNI accompany the Q-id when Wikidata holds them', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async (url, init) => {
    assert.equal(url, 'https://query.wikidata.org/sparql');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(qidsIn(init), ['Q5000001']);
    return sparqlResponse([{ qid: 'Q5000001', viaf: '116796842', isni: '0000 0001 2148 628X' }]);
  });
  try {
    const [out] = await enrichWithWikidata([edition('Q5000001')], log);
    assert.deepEqual(out?.identifiers, [
      providerIdentifier('wikidata', 'https://www.wikidata.org/entity/Q5000001'),
      providerIdentifier('viaf', 'https://viaf.org/viaf/116796842'),
      providerIdentifier('isni', 'https://isni.org/isni/000000012148628X'),
    ]);
  } finally { restore(); }
});

test('an item without a wikidata identifier costs no request', async () => {
  wikidataBreaker.recordSuccess();
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return sparqlResponse([]); });
  try {
    const input: EditionItem = { ...edition('Q5000002'), identifiers: [{ type: 'isbn', value: '9780123456789' }] };
    const out = await enrichWithWikidata([input], log);
    assert.equal(calls, 0, 'nothing to join on');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], input);
  } finally { restore(); }
});

test('an unmatched Q-id leaves the item exactly as it was', async () => {
  wikidataBreaker.recordSuccess();
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return sparqlResponse([]); });
  try {
    const input = edition('Q5000003');
    const out = await enrichWithWikidata([input], log);
    assert.equal(calls, 1, 'the lookup did happen');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], input);
  } finally { restore(); }
});

test('a Q-id with no authority links appends nothing', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async () => sparqlResponse([{ qid: 'Q5000004' }]));
  try {
    const input = edition('Q5000004');
    const [out] = await enrichWithWikidata([input], log);
    assert.deepEqual(out, input);
  } finally { restore(); }
});

test('identifiers are never grown past the lexicon cap of 32', async () => {
  wikidataBreaker.recordSuccess();
  const restore = stubFetch(async () => sparqlResponse([{ qid: 'Q5000005', viaf: '1', isni: '2' }]));
  try {
    const input: EditionItem = {
      ...edition('Q5000005'),
      identifiers: [
        ...Array.from({ length: 30 }, (_, i) => ({ type: 'example.org', value: String(i) })),
        providerIdentifier('wikidata', 'https://www.wikidata.org/entity/Q5000005'),
      ],
    };
    const [out] = await enrichWithWikidata([input], log);
    assert.equal(out?.identifiers.length, 32);
    assert.equal(out?.identifiers.at(-1)?.type, 'viaf.org', 'ISNI was dropped, not the cap');
  } finally { restore(); }
});

test('items sharing one Q-id are looked up once', async () => {
  wikidataBreaker.recordSuccess();
  const chunks: string[][] = [];
  const restore = stubFetch(async (_url, init) => {
    chunks.push(qidsIn(init));
    return sparqlResponse([{ qid: 'Q5000006', viaf: '42' }]);
  });
  try {
    const [a, b] = await enrichWithWikidata([edition('Q5000006'), edition('Q5000006')], log);
    assert.equal(chunks.length, 1, 'one request for the shared Q-id');
    assert.deepEqual(chunks[0], ['Q5000006']);
    assert.equal(a?.identifiers.at(-1)?.value, '42');
    assert.equal(b?.identifiers.at(-1)?.value, '42');
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
    const items = Array.from({ length: 120 }, (_, i) => edition(`Q${6_000_000 + i}`));
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
    const input = edition('Q5000008');
    const out = await enrichWithWikidata([input], log);
    assert.equal(attempts, 3, '5xx is retried before giving up');
    assert.deepEqual(out[0], input);
  } finally {
    wikidataBreaker.recordSuccess();
    restore();
  }
});
