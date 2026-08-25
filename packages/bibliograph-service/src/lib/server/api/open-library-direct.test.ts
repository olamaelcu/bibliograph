import test from 'node:test';
import assert from 'node:assert/strict';
import { getEditionByRkey, getWorkByRkey, getContributorByRkey } from './open-library.js';

test('getEditionByRkey maps OL JSON to EditionItem', async () => {
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: RequestInfo) => {
    assert.ok(String(url).includes('/books/OL7281956M.json'));
    return new Response(JSON.stringify({
      key: '/books/OL7281956M',
      title: 'Neuromancer',
      subtitle: 'Sprawl',
      first_publish_year: 1984,
      covers: [123],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const item = await getEditionByRkey('ol.OL7281956M', { info:()=>{}, warn:()=>{}, error:()=>{} } as never);
  assert.ok(item);
  assert.equal(item!.title, 'Neuromancer');
  assert.equal(item!.uri, 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.OL7281956M');
  (globalThis as any).fetch = origFetch;
});

test('getEditionByRkey returns null on 404', async () => {
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => new Response('Not found', { status: 404 });
  const item = await getEditionByRkey('ol.OL9999999M', { info:()=>{}, warn:()=>{}, error:()=>{} } as never);
  assert.equal(item, null);
  (globalThis as any).fetch = origFetch;
});

test('getWorkByRkey maps OL JSON to WorkItem', async () => {
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: RequestInfo) => {
    assert.ok(String(url).includes('/works/OL66554W.json'));
    return new Response(JSON.stringify({
      key: '/works/OL66554W',
      title: 'Neuromancer',
      subtitle: 'The Book of Knowledges',
      first_publish_year: 1984,
      subjects: ['Cyberpunk', 'AI'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const item = await getWorkByRkey('ol.W66554W', { info:()=>{}, warn:()=>{}, error:()=>{} } as never);
  assert.ok(item);
  assert.equal(item!.title, 'Neuromancer');
  assert.equal(item!.uri, 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/ol.W66554W');
  (globalThis as any).fetch = origFetch;
});

test('getContributorByRkey maps OL JSON to ContributorItem', async () => {
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: RequestInfo) => {
    assert.ok(String(url).includes('/authors/OL12345A.json'));
    return new Response(JSON.stringify({
      key: '/authors/OL12345A',
      name: 'William Gibson',
      birth_date: '1948-03-17',
      death_date: null,
      alternate_names: ['William M. Gibson', 'Bill Gibson'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const item = await getContributorByRkey('ol.A12345A', { info:()=>{}, warn:()=>{}, error:()=>{} } as never);
  assert.ok(item);
  assert.equal(item!.name, 'William Gibson');
  assert.equal(item!.uri, 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.A12345A');
  (globalThis as any).fetch = origFetch;
});