import test from 'node:test';
import assert from 'node:assert/strict';
import { getEditionByRkey, getWorkByRkey, getContributorByRkey } from './open-library.js';
import { isbn13FromAny } from '../identifiers';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} } as never;

/** Swap `globalThis.fetch` for a stub without widening it. */
function stubFetch(impl: (url: string) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => impl(String(url))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('getEditionByRkey maps OL JSON to EditionItem', async () => {
  const restore = stubFetch(async (url) => {
    assert.ok(url.includes('/books/OL7281956M.json'));
    return new Response(
      JSON.stringify({
        key: '/books/OL7281956M',
        title: 'Neuromancer',
        subtitle: 'Sprawl',
        first_publish_year: 1984,
        covers: [123],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  try {
    const item = await getEditionByRkey('ol.OL7281956M', silentLog);
    assert.ok(item);
    assert.equal(item!.title, 'Neuromancer');
    assert.equal(item!.uri, 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.OL7281956M');
  } finally {
    restore();
  }
});

test('getEditionByRkey returns null on 404', async () => {
  const restore = stubFetch(async () => new Response('Not found', { status: 404 }));
  try {
    const item = await getEditionByRkey('ol.OL9999999M', silentLog);
    assert.equal(item, null);
  } finally {
    restore();
  }
});

test('getEditionByRkey keeps the ISBNs the edition document carries', async () => {
  const restore = stubFetch(async () =>
    new Response(
      JSON.stringify({
        key: '/books/OL3292288M',
        title: 'Romance and rights',
        isbn_10: ['1578067057'],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
  try {
    const item = await getEditionByRkey('ol.OL3292288M', silentLog);
    assert.ok(item);
    assert.deepEqual(
      item!.identifiers.filter((identifier) => identifier.type !== 'openlibrary.org'),
      [{ type: 'isbn', value: isbn13FromAny('1578067057') }],
    );
  } finally {
    restore();
  }
});

test('getEditionByRkey does not invent an ISBN when the document has none', async () => {
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ key: '/books/OL3292288M', title: 'Romance and rights' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  try {
    const item = await getEditionByRkey('ol.OL3292288M', silentLog);
    assert.ok(item);
    assert.equal(item!.identifiers.some((identifier) => identifier.type === 'isbn'), false);
  } finally {
    restore();
  }
});

test('getWorkByRkey maps OL JSON to WorkItem', async () => {
  const restore = stubFetch(async (url) => {
    assert.ok(url.includes('/works/OL66554W.json'));
    return new Response(
      JSON.stringify({
        key: '/works/OL66554W',
        title: 'Neuromancer',
        subtitle: 'The Book of Knowledges',
        first_publish_year: 1984,
        subjects: ['Cyberpunk', 'AI'],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  try {
    const item = await getWorkByRkey('ol.W66554W', silentLog);
    assert.ok(item);
    assert.equal(item!.title, 'Neuromancer');
    assert.equal(item!.uri, 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/ol.W66554W');
  } finally {
    restore();
  }
});

test('getContributorByRkey maps OL JSON to ContributorItem', async () => {
  const restore = stubFetch(async (url) => {
    assert.ok(url.includes('/authors/OL12345A.json'));
    return new Response(
      JSON.stringify({
        key: '/authors/OL12345A',
        name: 'William Gibson',
        birth_date: '1948-03-17',
        death_date: null,
        alternate_names: ['William M. Gibson', 'Bill Gibson'],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  try {
    const item = await getContributorByRkey('ol.A12345A', silentLog);
    assert.ok(item);
    assert.equal(item!.name, 'William Gibson');
    assert.equal(item!.uri, 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.A12345A');
  } finally {
    restore();
  }
});
