import test from 'node:test';
import assert from 'node:assert/strict';

import { EDITION_COLLECTION, getEditionGenres } from '../src/lib/server/catalog/genres.ts';
import type { EntityQueryable } from '../src/lib/server/catalog/entities.ts';

const EDITION_URI = `at://did:plc:genretest/${EDITION_COLLECTION}/3abc`;

type QueryCall = { sql: string; values?: unknown[] };

/** A test double exposing only `query`, which is all the module uses. */
function fakePool(
  answers: { present?: boolean; genres?: { name: string; source: string }[] }
): { pool: EntityQueryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      const rows = sql.includes('EXISTS')
        ? [{ present: answers.present === true }]
        : (answers.genres ?? []);
      return { rows, rowCount: rows.length };
    }
  } as unknown as EntityQueryable;
  return { pool, calls };
}

test('getEditionGenres answers null when the edition is not in the catalog', async () => {
  const { pool } = fakePool({ present: false, genres: [{ name: 'Fantasy', source: 'goodreads' }] });
  assert.equal(await getEditionGenres(pool, EDITION_URI), null);
});

test('getEditionGenres maps the rows in query order', async () => {
  const { pool } = fakePool({
    present: true,
    genres: [
      { name: 'Science Fiction', source: 'goodreads' },
      { name: 'Fiction', source: 'openlibrary' }
    ]
  });

  assert.deepEqual(await getEditionGenres(pool, EDITION_URI), {
    uri: EDITION_URI,
    genres: [
      { name: 'Science Fiction', source: 'goodreads' },
      { name: 'Fiction', source: 'openlibrary' }
    ]
  });
});

test('getEditionGenres answers an empty list for a known edition with no genres', async () => {
  const { pool } = fakePool({ present: true, genres: [] });
  assert.deepEqual(await getEditionGenres(pool, EDITION_URI), {
    uri: EDITION_URI,
    genres: []
  });
});

test('both queries parameterize the URI and nothing else', async () => {
  const { pool, calls } = fakePool({ present: true, genres: [] });
  await getEditionGenres(pool, EDITION_URI);

  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual(call.values, [EDITION_URI]);
  assert.match(calls[0].sql, /FROM editions WHERE uri = \$1/);
  assert.match(calls[1].sql, /ORDER BY eg\.position, g\.name/);
});
