import { expect, test } from 'vitest';

import {
  SEARCH_CACHE_CAPACITY,
  SEARCH_CACHE_TTL_MS,
  createSearchCache,
  keyFor,
  remember,
  searchCache,
  type SearchCache,
  type SearchCacheInput
} from '../src/lib/server/catalog/search-cache.ts';

/**
 * The cache is pure in-memory state, so these tests need no database: the clock
 * is injectable, and `remember` takes the cache as an argument.
 */

const BASE: SearchCacheInput = {
  q: 'dune',
  identifiers: [],
  offset: 0,
  limit: 25,
  sort: 'relevance',
  order: 'asc'
};

test('the shipped cache has the documented capacity and TTL', () => {
  expect(SEARCH_CACHE_CAPACITY).toBe(200);
  expect(SEARCH_CACHE_TTL_MS).toBe(10_000);
  expect(searchCache.get('never-stored')).toBe(undefined);
});

test('a stored page is a hit until its TTL runs out', () => {
  let now = 1_000;
  const cache = createSearchCache<{ title: string }>({ ttlMs: 5_000, now: () => now });
  const value = { title: 'Dune' };

  expect(cache.get('k')).toBe(undefined);
  cache.set('k', value);
  now += 4_999;
  expect(cache.get('k')).toBe(value);
  // Reading does not extend the TTL: age is measured from the store.
  now += 1;
  expect(cache.get('k')).toBe(undefined);
});

test('the least recently used entry is evicted at capacity', () => {
  const cache = createSearchCache<string>({ capacity: 2, ttlMs: 60_000 });
  cache.set('a', 'A');
  cache.set('b', 'B');
  expect(cache.get('a')).toBe('A');

  cache.set('c', 'C');
  expect(cache.get('b'), 'b was least recently used').toBe(undefined);
  expect(cache.get('a')).toBe('A');
  expect(cache.get('c')).toBe('C');

  // Overwriting a key does not grow the cache or evict a neighbour.
  cache.set('a', 'A2');
  expect(cache.get('a')).toBe('A2');
  expect(cache.get('c')).toBe('C');
});

test('identical requests share one key', () => {
  const copy: SearchCacheInput = {
    ...BASE,
    identifiers: [{ issuer: 'isbn13', value: '9780441013593' }]
  };
  const same: SearchCacheInput = {
    ...copy,
    identifiers: [{ issuer: 'isbn13', value: '9780441013593' }]
  };
  expect(keyFor(same, 'https://edge.test')).toBe(keyFor(copy, 'https://edge.test'));
});

test('every input that changes the page changes the key', () => {
  const base = keyFor(BASE, 'https://edge.test');
  const variants: Array<[string, SearchCacheInput, string]> = [
    ['q', { ...BASE, q: 'dune messiah' }, 'https://edge.test'],
    ['title', { ...BASE, title: 'Dune' }, 'https://edge.test'],
    ['author', { ...BASE, author: 'Frank Herbert' }, 'https://edge.test'],
    ['language', { ...BASE, language: 'en' }, 'https://edge.test'],
    [
      'identifiers',
      { ...BASE, identifiers: [{ issuer: 'isbn13', value: '9780441013593' }] },
      'https://edge.test'
    ],
    ['sort', { ...BASE, sort: 'title' }, 'https://edge.test'],
    ['order', { ...BASE, order: 'desc' }, 'https://edge.test'],
    ['limit', { ...BASE, limit: 10 }, 'https://edge.test'],
    ['offset', { ...BASE, offset: 25 }, 'https://edge.test'],
    ['coversBaseUrl', BASE, 'https://other.test'],
    // Dropping the term is a different request (it serialises as `null`).
    ['q absent', { ...BASE, q: undefined }, 'https://edge.test']
  ];

  for (const [field, input, coversBaseUrl] of variants) {
    expect(keyFor(input, coversBaseUrl), `${field} must change the key`).not.toBe(base);
  }

  // Identifier order is part of the request.
  const ordered = keyFor(
    {
      ...BASE,
      identifiers: [
        { issuer: 'isbn13', value: '9780441013593' },
        { issuer: 'oclc', value: '367444' }
      ]
    },
    'https://edge.test'
  );
  const swapped = keyFor(
    {
      ...BASE,
      identifiers: [
        { issuer: 'oclc', value: '367444' },
        { issuer: 'isbn13', value: '9780441013593' }
      ]
    },
    'https://edge.test'
  );
  expect(swapped).not.toBe(ordered);
});

test('a hit answers without calling the loader', async () => {
  const cache = createSearchCache<number>({ ttlMs: 60_000 });
  let loads = 0;
  const load = async (): Promise<number> => {
    loads += 1;
    return loads;
  };

  expect(await remember(cache, 'k', load)).toEqual({ value: 1, hit: false });
  expect(await remember(cache, 'k', load)).toEqual({ value: 1, hit: true });
  expect(loads, 'the second call is served from the cache').toBe(1);
});

test('a thrown load is never cached', async () => {
  const cache = createSearchCache<string>({ ttlMs: 60_000 });
  let attempts = 0;
  const load = async (): Promise<string> => {
    attempts += 1;
    throw new Error('catalog unavailable');
  };

  await expect(remember(cache, 'k', load)).rejects.toThrow('catalog unavailable');
  await expect(remember(cache, 'k', load)).rejects.toThrow('catalog unavailable');
  expect(attempts, 'the failed query is retried, not replayed').toBe(2);
  expect(cache.get('k')).toBe(undefined);
});

test('a cache fault never fails the request', async () => {
  const faulty: SearchCache<string> = {
    get() {
      throw new Error('cache read failed');
    },
    set() {
      throw new Error('cache write failed');
    }
  };

  await expect(remember(faulty, 'k', async () => 'answer')).resolves.toEqual({
    value: 'answer',
    hit: false
  });
});
