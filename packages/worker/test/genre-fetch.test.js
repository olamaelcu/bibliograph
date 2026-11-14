/**
 * `catalog.genres`: which providers are asked, in what order, and what the
 * ledger records when a metered provider refuses.
 *
 * The pool is scripted, so these tests assert the statements themselves: the
 * free providers answer from one batch, ISBNdb is only touched when they
 * produced nothing, and a quota refusal never writes "no genres".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTasks } from '../lib/tasks.js';

const EDITION = 'at://did:plc:publisher/community.lexicon.media.book.edition/3abc';
const log = { info() {}, warn() {}, error() {} };

function taskPool({ hasGenres = false, identifiers = [{ issuer: 'isbn13', value: '9780441478125' }] } = {}) {
  const statements = [];
  const record = (sql, values) => {
    statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
  };
  const client = {
    query: async (sql, values) => {
      record(sql, values);
      if (sql.includes('INSERT INTO genres')) return { rows: [{ id: 7 }] };
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    statements,
    connect: async () => client,
    query: async (sql, values) => {
      record(sql, values);
      if (sql.includes('AS has_genres')) return { rows: [{ has_genres: hasGenres }] };
      if (sql.includes('FROM edition_identifiers')) return { rows: identifiers };
      return { rows: [] };
    }
  };
  return { pool, statements };
}

function genreProviders({ goodreads = [], openlibrary = [], isbndb } = {}) {
  const calls = { goodreads: 0, openlibrary: 0, isbndb: 0 };
  const wrap = (name, answer) => async () => {
    calls[name] += 1;
    const value = typeof answer === 'function' ? answer() : answer;
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    calls,
    providers: {
      goodreads: { genresForEdition: wrap('goodreads', goodreads) },
      openlibrary: { genresForEdition: wrap('openlibrary', openlibrary) },
      ...(isbndb === undefined
        ? {}
        : { isbndb: { genresForEdition: wrap('isbndb', isbndb) } })
    }
  };
}

function storedSources(statements) {
  return statements
    .filter((statement) => statement.sql.includes('INSERT INTO edition_genres'))
    .map((statement) => statement.values[3]);
}

test('a free provider answer is stored without touching the metered one', async () => {
  const { pool, statements } = taskPool();
  const genres = genreProviders({ goodreads: ['Fantasy'], openlibrary: ['Classics'] });
  const tasks = createTasks({ pool, providers: genres, publisherHost: 'genres.example' });

  await tasks['catalog.genres']({ editionUri: EDITION }, { logger: log });

  assert.equal(genres.calls.isbndb, 0, 'ISBNdb spends only when nothing else answered');
  assert.deepEqual(storedSources(statements), ['goodreads', 'openlibrary']);
  const settled = statements.find((statement) => statement.sql.includes('outcome = '));
  assert.match(settled?.sql ?? '', /outcome = 'found'/, 'the ledger records a real answer');
});

test('ISBNdb is asked when both free providers come back empty, and supplies the genres', async () => {
  const { pool, statements } = taskPool();
  const genres = genreProviders({ isbndb: ['Poetry', 'Classics'] });
  const tasks = createTasks({ pool, providers: genres, publisherHost: 'genres.example' });

  await tasks['catalog.genres']({ editionUri: EDITION }, { logger: log });

  assert.equal(genres.calls.isbndb, 1);
  assert.deepEqual(storedSources(statements), ['isbndb', 'isbndb']);
  const names = statements
    .filter((statement) => statement.sql.includes('INSERT INTO genres'))
    .map((statement) => statement.values[0]);
  assert.deepEqual(names, ['Classics', 'Poetry'], 'subject sources are stored alphabetically');
});

test('a refused ISBNdb quota marks nothing and writes no genres', async () => {
  const { pool, statements } = taskPool();
  const genres = genreProviders({ isbndb: () => undefined });
  const tasks = createTasks({ pool, providers: genres, publisherHost: 'genres.example' });

  await tasks['catalog.genres']({ editionUri: EDITION }, { logger: log });

  assert.equal(genres.calls.isbndb, 1);
  assert.deepEqual(storedSources(statements), []);
  assert.ok(
    !statements.some((statement) => statement.sql.includes("outcome = 'none'")),
    'an unasked edition must not be recorded as genreless'
  );
});

test('an ISBNdb answer still lands when both free providers failed', async () => {
  const { pool, statements } = taskPool();
  const genres = genreProviders({
    goodreads: () => new Error('challenge'),
    openlibrary: () => new Error('outage'),
    isbndb: ['Poetry']
  });
  const tasks = createTasks({ pool, providers: genres, publisherHost: 'genres.example' });

  await assert.doesNotReject(() =>
    tasks['catalog.genres']({ editionUri: EDITION }, { logger: log })
  );

  assert.deepEqual(storedSources(statements), ['isbndb']);
});

test('an edition that already has genres is not re-fetched', async () => {
  const { pool } = taskPool({ hasGenres: true });
  const genres = genreProviders({ goodreads: ['Fantasy'], isbndb: ['Poetry'] });
  const tasks = createTasks({ pool, providers: genres, publisherHost: 'genres.example' });

  await tasks['catalog.genres']({ editionUri: EDITION }, { logger: log });

  assert.deepEqual(genres.calls, { goodreads: 0, openlibrary: 0, isbndb: 0 });
});
