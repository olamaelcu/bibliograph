import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { enrichContributorBios } from './wikipedia.ts';
import type { ContributorItem } from '../search/types.ts';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test('enrichContributorBios writes bio from Wikipedia extract', async () => {
  const restore = stubFetch(async (url) => {
    assert.match(url, /wikipedia\.org\/w\/api\.php/);
    assert.match(url, /titles=Jane%20Doe/);
    return new Response(JSON.stringify({
      query: { pages: { '1': { extract: 'Jane Doe is a writer.', title: 'Jane Doe' } } },
    }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const items: ContributorItem[] = [{ name: 'Jane Doe', aliases: [], identifiers: [], createdAt: new Date().toISOString() }];
    const [out] = await enrichContributorBios(items, log);
    assert.equal(out.bio, 'Jane Doe is a writer.');
  } finally { restore(); }
});

test('enrichContributorBios skips when Wikipedia returns no pages', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    query: { pages: { '-1': { title: 'Ghost', missing: '' } } },
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const items: ContributorItem[] = [{ name: 'Ghost', aliases: [], identifiers: [], createdAt: new Date().toISOString() }];
    const [out] = await enrichContributorBios(items, log);
    assert.equal(out.bio, undefined);
  } finally { restore(); }
});

test('enrichContributorBios dedupes by name within a single call', async () => {
  let calls = 0;
  const restore = stubFetch(async (_url) => { calls++; return new Response(JSON.stringify({
    query: { pages: { '1': { extract: 'X' } } },
  }), { headers: { 'content-type': 'application/json' } }); });
  try {
    const items: ContributorItem[] = [
      { name: 'Same', aliases: [], identifiers: [], createdAt: new Date().toISOString() },
      { name: 'Same', aliases: [], identifiers: [], createdAt: new Date().toISOString() },
    ];
    await enrichContributorBios(items, log);
    assert.equal(calls, 1);
  } finally { restore(); }
});
