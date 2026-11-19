import { describe, expect, test } from 'vitest';

import {
  engineConfig,
  parseSearchBackend,
  searchEngineUris,
  topOverlap
} from '../src/lib/server/catalog/search-engine.ts';

describe('parseSearchBackend', () => {
  test('accepts the three names and falls back to postgres', () => {
    expect(parseSearchBackend('tantivy')).toBe('tantivy');
    expect(parseSearchBackend(' SHADOW ')).toBe('shadow');
    expect(parseSearchBackend('postgres')).toBe('postgres');
    expect(parseSearchBackend('elasticsearch')).toBe('postgres');
    expect(parseSearchBackend(undefined)).toBe('postgres');
    expect(parseSearchBackend('')).toBe('postgres');
  });
});

describe('engineConfig', () => {
  test('trims the url and defaults the timeout', () => {
    expect(engineConfig({ SEARCH_URL: 'http://127.0.0.1:3102/' })).toEqual({
      url: 'http://127.0.0.1:3102',
      timeoutMs: 400
    });
  });

  test('unset url disables the engine, bad timeout falls back', () => {
    expect(engineConfig({}).url).toBeUndefined();
    expect(engineConfig({ SEARCH_URL: '   ' }).url).toBeUndefined();
    expect(engineConfig({ SEARCH_ENGINE_TIMEOUT_MS: 'soon' }).timeoutMs).toBe(400);
    expect(engineConfig({ SEARCH_ENGINE_TIMEOUT_MS: '900' }).timeoutMs).toBe(900);
  });
});

describe('searchEngineUris', () => {
  const okBody = { uris: ['at://a', 'at://b'], hasMore: true, total: 42 };

  function stub(response: Partial<Response> & { json?: () => Promise<unknown> }) {
    return (async () => response as Response) as typeof fetch;
  }

  test('maps the service response', async () => {
    const result = await searchEngineUris(
      { q: 'dune', offset: 0, limit: 25 },
      { url: 'http://x', timeoutMs: 400, fetchImpl: stub({ ok: true, json: async () => okBody }) }
    );
    expect(result).toEqual({ uris: ['at://a', 'at://b'], hasMore: true, total: 42 });
  });

  test('a non-2xx answer throws so the caller can fall back', async () => {
    await expect(
      searchEngineUris(
        { q: 'dune', offset: 0, limit: 25 },
        {
          url: 'http://x',
          timeoutMs: 400,
          fetchImpl: stub({ ok: false, status: 503, json: async () => ({}) })
        }
      )
    ).rejects.toThrow(/HTTP 503/);
  });

  test('a malformed body throws', async () => {
    for (const body of [null, [], { uris: 'nope' }, { uris: [1] }]) {
      await expect(
        searchEngineUris(
          { q: 'dune', offset: 0, limit: 25 },
          { url: 'http://x', timeoutMs: 400, fetchImpl: stub({ ok: true, json: async () => body }) }
        )
      ).rejects.toThrow();
    }
  });

  test('hasMore is only true when it is literally true', async () => {
    const result = await searchEngineUris(
      { q: 'dune', offset: 0, limit: 25 },
      {
        url: 'http://x',
        timeoutMs: 400,
        fetchImpl: stub({ ok: true, json: async () => ({ uris: ['at://a'], hasMore: 'yes' }) })
      }
    );
    expect(result).toEqual({ uris: ['at://a'], hasMore: false, total: 0 });
  });
});

describe('topOverlap', () => {
  test('identical pages agree, disjoint pages do not', () => {
    expect(topOverlap(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(topOverlap(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(topOverlap([], [])).toBe(1);
  });

  test('order does not matter but size does', () => {
    expect(topOverlap(['a', 'b'], ['b', 'a'])).toBe(1);
    expect(topOverlap(['a', 'b', 'c', 'd'], ['a', 'b'])).toBe(0.5);
  });

  test('only the first k positions count', () => {
    const left = Array.from({ length: 30 }, (_, i) => `u${i}`);
    expect(topOverlap(left, ['x', ...left.slice(0, 24)], 25)).toBe(0.96);
  });
});
