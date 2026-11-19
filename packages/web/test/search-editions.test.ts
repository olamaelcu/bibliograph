import { expect, test } from 'vitest';

import { searchEditions } from '../src/lib/server/catalog/books.ts';
import type { BookQueryable, BookRow } from '../src/lib/server/catalog/book-view.ts';

/**
 * `searchEditions` against a recording double: the page rule is about which
 * statements are issued, and a full first page must not issue the `count(*)`.
 */

type QueryCall = { sql: string; values?: unknown[] };

/** A test double exposing only `query`, answering the page and hydration. */
function fakePool(pageRows: BookRow[]): { pool: BookQueryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      let rows: unknown[] = [];
      if (sql.includes('count(*)::int AS n')) rows = [{ n: 999 }];
      // All three hydration reads are `= ANY($1)`; empty answers are fine.
      else if (sql.includes('= ANY($1)')) rows = [];
      else rows = pageRows;
      return { rows, rowCount: rows.length };
    }
  };
  return { pool: pool as unknown as BookQueryable, calls };
}

function bookRow(index: number): BookRow {
  return {
    uri: `at://did:plc:searchtest/community.lexicon.media.book.edition/${index}`,
    title: `Title ${index}`,
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

test('a full first page omits total and issues no count', async () => {
  // `limit + 1` rows came back, so the page is full and there is more behind it.
  const { pool, calls } = fakePool([bookRow(1), bookRow(2), bookRow(3)]);

  const results = await searchEditions(
    { identifiers: [], offset: 0, limit: 2, title: 'Dune' },
    pool
  );

  expect(results.items).toHaveLength(2);
  expect(results.hasMore).toBe(true);
  expect(results.total, 'a full page has no exact total to send').toBeUndefined();
  expect(
    calls.filter((call) => call.sql.includes('count(*)')),
    'the count scan was removed from search'
  ).toEqual([]);
});

test('a short first page carries its exact length as total, still without a count', async () => {
  const { pool, calls } = fakePool([bookRow(1)]);

  const results = await searchEditions(
    { identifiers: [], offset: 0, limit: 2, title: 'Dune' },
    pool
  );

  expect(results.items).toHaveLength(1);
  expect(results.hasMore).toBe(false);
  expect(results.total, 'a short page is the whole match set').toBe(1);
  expect(calls.filter((call) => call.sql.includes('count(*)'))).toEqual([]);
});

test('a page past the first never carries a total', async () => {
  const { pool, calls } = fakePool([bookRow(1), bookRow(2), bookRow(3)]);

  const results = await searchEditions(
    { identifiers: [], offset: 5, limit: 2, title: 'Dune' },
    pool
  );

  expect(results.total).toBeUndefined();
  expect(results.hasMore).toBe(true);
  expect(calls.filter((call) => call.sql.includes('count(*)'))).toEqual([]);
});
