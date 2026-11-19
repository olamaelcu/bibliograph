import { expect, test } from 'vitest';

import { ENTITY_QUERIES, SEARCH_EDITIONS_TYPEAHEAD } from '../src/lib/server/catalog/entity-methods.ts';
import { typeaheadEditions } from '../src/lib/server/catalog/typeahead.ts';
import type { BookQueryable, BookRow } from '../src/lib/server/catalog/book-view.ts';

/**
 * `typeaheadEditions` chooses between the external index and Postgres, so the
 * double answers both shapes: the page query (contains `book_search`), the
 * ranked hydration (`array_position`) and the ordinary hydration reads
 * (`= ANY($1)`).
 */

type QueryCall = { sql: string; values?: unknown[] };

function bookRow(uri: string): BookRow {
  return {
    uri,
    // The rkey half, so a hydrated row is traceable to the uri that ranked it.
    title: `Title ${uri.slice(uri.lastIndexOf('/') + 1)}`,
    subtitle: null,
    shape_language: null,
    shape_published_date: null,
    shape_format: null,
    shape_pages: null,
    duration_seconds: null,
    chapters: null,
    series: null,
    book_edition: null,
    shape_description: null,
    cover_url: null,
    cover_cached: false,
    created_at: new Date('2026-01-01T00:00:00.000Z')
  };
}

function fakePool(pageRows: BookRow[]): { pool: BookQueryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      let rows: unknown[] = [];
      if (sql.includes('array_position')) {
        rows = ((values?.[0] as string[] | undefined) ?? []).map((uri) => bookRow(uri));
      } else if (sql.includes('book_search')) {
        rows = pageRows;
      }
      return { rows, rowCount: rows.length };
    }
  };
  return { pool: pool as unknown as BookQueryable, calls };
}

function unreachableFetch(): typeof fetch {
  return (async () => {
    throw new Error('the engine must not be called on this path');
  }) as unknown as typeof fetch;
}

function viewTitles(items: { title: string }[]): string[] {
  return items.map((item) => item.title);
}

test('the typeahead NSID is registered as an entity query under one literal', () => {
  expect(SEARCH_EDITIONS_TYPEAHEAD).toBe(
    'net.olamaelcu.livtet.biblio.searchEditionsTypeahead'
  );
  expect(ENTITY_QUERIES.has(SEARCH_EDITIONS_TYPEAHEAD)).toBe(true);
});

test('the postgres backend answers from searchEditions without touching the engine', async () => {
  const { pool, calls } = fakePool([bookRow('at://did:plc:t/edition/1')]);

  const result = await typeaheadEditions(
    { q: 'dune', limit: 8 },
    pool,
    { SEARCH_BACKEND: 'postgres' },
    unreachableFetch()
  );

  expect(result.outcome).toBe('ok');
  expect(viewTitles(result.items)).toEqual(['Title 1']);
  expect(calls.some((call) => call.sql.includes('book_search'))).toBe(true);
});

test('the tantivy backend hydrates the engine uris in rank order', async () => {
  const uris = ['at://did:plc:t/edition/2', 'at://did:plc:t/edition/1'];
  const engineFetch = (async () => ({
    ok: true,
    json: async () => ({ uris })
  })) as unknown as typeof fetch;
  const { pool, calls } = fakePool([]);

  const result = await typeaheadEditions(
    { q: 'dune her', limit: 8 },
    pool,
    { SEARCH_BACKEND: 'tantivy', SEARCH_URL: 'http://engine' },
    engineFetch
  );

  expect(result.outcome).toBe('ok');
  expect(calls[0].sql, 'hydration is the first statement, before any page query').toContain(
    'array_position'
  );
  expect(calls[0].values?.[0]).toEqual(uris);
  expect(viewTitles(result.items)).toEqual(['Title 2', 'Title 1']);
  expect(calls.some((call) => call.sql.includes('book_search'))).toBe(false);
});

test('an engine failure falls back to the Postgres page and says so', async () => {
  const engineFetch = (async () => ({
    ok: false,
    status: 503,
    json: async () => ({})
  })) as unknown as typeof fetch;
  const { pool, calls } = fakePool([bookRow('at://did:plc:t/edition/1')]);

  const result = await typeaheadEditions(
    { q: 'dune', limit: 8 },
    pool,
    { SEARCH_BACKEND: 'tantivy', SEARCH_URL: 'http://engine' },
    engineFetch
  );

  expect(result.outcome).toBe('engine_fallback');
  expect(viewTitles(result.items)).toEqual(['Title 1']);
  expect(calls.some((call) => call.sql.includes('book_search'))).toBe(true);
});
