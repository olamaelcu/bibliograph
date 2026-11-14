/**
 * ISBNdb as a genre source: the deprecated `subjects` list, read through the
 * provider's own response cache and daily-quota accounting.
 *
 * The pool is scripted, so these assertions are about which statements the
 * provider issues: a cached `/book/{isbn}` must cost neither a network call nor
 * a daily call, and a refused quota must answer "not asked" (undefined) rather
 * than "no genres" ([]).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createIsbndb, subjectsFromBook } from '../lib/providers/isbndb.js';

const ISBN13 = '9780441478125';
const BOOK_URL = `https://isbndb.test/book/${ISBN13}`;

/** A pool that answers the cache lookup and the quota reservation by script. */
function scriptedPool({ cached, reserved = 1 } = {}) {
  const statements = [];
  return {
    statements,
    query: async (sql) => {
      const compact = sql.replace(/\s+/g, ' ').trim();
      statements.push(compact);
      if (compact.includes('FROM isbndb_cache')) {
        return { rows: cached === undefined ? [] : [{ body: cached }] };
      }
      if (compact.includes('INSERT INTO provider_daily_usage')) {
        return { rows: reserved === null ? [] : [{ calls: reserved }] };
      }
      return { rows: [] };
    }
  };
}

function provider(pool, { onFetch } = {}) {
  const fetches = [];
  return {
    fetches,
    provider: createIsbndb({
      pool,
      apiKey: 'test-key',
      baseUrl: 'https://isbndb.test',
      fetchImpl: async (url) => {
        fetches.push(String(url));
        return onFetch ? onFetch() : new Response('{}', { status: 200 });
      },
      logger: { warn() {} }
    })
  };
}

test('subjectsFromBook keeps provider order and drops empty labels', () => {
  assert.deepEqual(subjectsFromBook({ subjects: ['Biology', ' Textbooks ', ''] }), [
    'Biology',
    'Textbooks'
  ]);
  assert.deepEqual(subjectsFromBook({ subjects: [null, 42] }), []);
  assert.deepEqual(subjectsFromBook({}), []);
  assert.deepEqual(subjectsFromBook(null), []);
});

test('a cached book record answers genres with no call and no quota spend', async () => {
  const pool = scriptedPool({
    cached: { book: { subjects: ['Poetry', 'Classics'] } }
  });
  const { provider: isbndb, fetches } = provider(pool);

  const subjects = await isbndb.genresForEdition([{ issuer: 'isbn13', value: ISBN13 }]);

  assert.deepEqual(subjects, ['Poetry', 'Classics']);
  assert.deepEqual(fetches, [], 'the cache answers before the network');
  assert.ok(
    !pool.statements.some((sql) => sql.includes('provider_daily_usage')),
    'a cache hit reserves no daily call'
  );
});

test('a cache miss fetches the book once and caches the answer', async () => {
  const pool = scriptedPool();
  const { provider: isbndb, fetches } = provider(pool, {
    onFetch: () =>
      new Response(JSON.stringify({ book: { subjects: ['Biology'] } }), { status: 200 })
  });

  const subjects = await isbndb.genresForEdition([{ issuer: 'isbn13', value: ISBN13 }]);

  assert.deepEqual(subjects, ['Biology']);
  assert.deepEqual(fetches, [BOOK_URL]);
  assert.ok(pool.statements.some((sql) => sql.includes('provider_daily_usage')));
  assert.ok(
    pool.statements.some((sql) => sql.includes('INSERT INTO isbndb_cache')),
    'the full book record is cached for the next genre or hydration read'
  );
});

test('a refused daily quota answers undefined instead of no genres', async () => {
  const pool = scriptedPool({ reserved: null });
  const { provider: isbndb, fetches } = provider(pool);

  const subjects = await isbndb.genresForEdition([{ issuer: 'isbn13', value: ISBN13 }]);

  assert.equal(subjects, undefined);
  assert.deepEqual(fetches, [], 'the quota refusal must not touch the network');
});

test('a missing ISBN or a 404 answers an empty list without a lookup', async () => {
  const empty = provider(scriptedPool());
  assert.deepEqual(await empty.provider.genresForEdition([]), []);
  assert.deepEqual(await empty.provider.genresForEdition([{ issuer: 'openlibrary', value: 'OL1A' }]), []);
  assert.deepEqual(empty.fetches, []);

  const missing = provider(scriptedPool(), {
    onFetch: () => new Response('{}', { status: 404 })
  });
  assert.deepEqual(
    await missing.provider.genresForEdition([{ issuer: 'isbn10', value: '0441478123' }]),
    []
  );
});
