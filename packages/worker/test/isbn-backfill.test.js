/**
 * `catalog.isbn.backfill`: what one edition's job writes.
 *
 * Runs against the throwaway Postgres the vitest global setup starts, so the
 * identifier, claim-row and outbox triggers are the real ones. The providers are
 * fakes (this file is about the ledger and the attach, not HTTP), and the ledger
 * row is inserted the way `catalog_enqueue_isbn_backfill` leaves it — the claim
 * happens before the job runs.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import pg from 'pg';

import { createTasks } from '../lib/tasks.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = process.hrtime.bigint().toString(36);
const PREFIX = `at://did:plc:isbnbackfillprobe/community.lexicon.media.book.edition/${RUN}`;
const uri = (suffix) => `${PREFIX}-${suffix}`;
const TITLE = 'The Left Hand of Darkness';
const ISBN = '9780441478125';
// Every fixture owns its own ISBN: the identifier table is global, so a shared
// value would turn a later test's attach into a conflict.
const EXISTING_ISBN = '9780000000019';
const IDEMPOTENT_ISBN = '9780000000026';
const CONFLICT_ISBN = '9780000000033';
const BUDGET_ISBN = '9780000000040';
const AUTHOR = `ISBN Backfill Probe Author ${RUN}`;
const log = { info() {}, warn() {}, error() {} };

let pool;

/** A book with no ISBN, plus the claim row the enqueue function would leave. */
async function claimedBook(suffix, { title = TITLE, isbn = null } = {}) {
  const target = uri(suffix);
  await pool.query(`INSERT INTO books (uri, title, created_at) VALUES ($1, $2, now())`, [
    target,
    title
  ]);
  if (isbn) {
    await pool.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value)
       VALUES ($1, 'isbn13', $2)`,
      [target, isbn]
    );
  }
  await pool.query(
    `INSERT INTO edition_isbn_backfill (edition_uri, outcome) VALUES ($1, 'skipped')`,
    [target]
  );
  return target;
}

function candidate({ title = TITLE, isbn13 = ISBN, ...extra } = {}) {
  return { title, identifiers: [{ issuer: 'isbn13', value: isbn13 }], ...extra };
}

/** Providers whose every answer is the same list, with the calls recorded. */
function stubProviders({ candidates = [], error } = {}) {
  const calls = { openlibrary: [], goodreads: [], google: [], pages: [], isbndb: 0 };
  const answer = async () => {
    if (error) throw error;
    return candidates;
  };
  return {
    calls,
    registry: {
      providers: {
        openlibrary: {
          search: async (query) => {
            calls.openlibrary.push(query);
            return answer();
          }
        },
        goodreads: {
          search: async (text) => {
            calls.goodreads.push(text);
            return answer();
          },
          byId: async (id) => {
            calls.pages.push(id);
            return answer();
          }
        },
        google: {
          search: async (query) => {
            calls.google.push(query);
            return answer();
          }
        },
        // Never asked by this job: the sweep must not spend the metered quota.
        isbndb: {
          byIsbn: async () => {
            calls.isbndb += 1;
            return [];
          },
          search: async () => {
            calls.isbndb += 1;
            return [];
          }
        }
      }
    }
  };
}

function tasksFor(registry, options = {}) {
  return createTasks({
    pool,
    providers: registry,
    publisherHost: 'isbn.example',
    isbnBackfillPerDay: 1000,
    ...options
  });
}

async function ledger(target) {
  const { rows } = await pool.query(
    `SELECT outcome, source, isbn, requested_at
       FROM edition_isbn_backfill WHERE edition_uri = $1`,
    [target]
  );
  return rows[0];
}

async function identifierCount(target, issuer = 'isbn13') {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM edition_identifiers
      WHERE edition_uri = $1 AND issuer = $2`,
    [target, issuer]
  );
  return rows[0].count;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  await pool.query('INSERT INTO contributors (name) VALUES ($1)', [AUTHOR]);
});

afterAll(async () => {
  await pool.query('DELETE FROM books WHERE uri LIKE $1', [`${PREFIX}%`]);
  await pool.query(
    `DELETE FROM contributors c
      WHERE c.name = $1
        AND NOT EXISTS (SELECT 1 FROM edition_contributors ec WHERE ec.contributor_id = c.id)`,
    [AUTHOR]
  );
  await pool.end();
});

test('an edition that already has an ISBN is recorded skipped without a lookup', async () => {
  const target = await claimedBook('has-isbn', { isbn: EXISTING_ISBN });
  const { registry, calls } = stubProviders({ candidates: [candidate()] });

  const result = await tasksFor(registry)['catalog.isbn.backfill'](
    { editionUri: target },
    { logger: log }
  );

  expect(result).toEqual({ status: 'skipped' });
  expect(calls.openlibrary.length + calls.goodreads.length + calls.google.length).toBe(0);
  expect((await ledger(target)).outcome).toBe('skipped');
  expect(await identifierCount(target), 'no second identifier is written').toBe(1);
});

test('a found ISBN is attached with the claim row and recorded in the ledger', async () => {
  const target = await claimedBook('found');
  await pool.query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
     SELECT $1, id, 0, 'author' FROM contributors WHERE name = $2`,
    [target, AUTHOR]
  );
  const found = candidate({
    language: 'en',
    publishedDate: '1969-03-01',
    pages: 304,
    description: 'A cold planet and an envoy.'
  });
  const { registry, calls } = stubProviders({ candidates: [found] });

  const result = await tasksFor(registry)['catalog.isbn.backfill'](
    { editionUri: target },
    { logger: log }
  );

  expect(result).toEqual({ status: 'found', isbn: ISBN, source: 'openlibrary' });
  expect(calls.isbndb, 'the metered provider is never asked').toBe(0);
  expect(calls.openlibrary[0], 'the catalog title and author are the query').toEqual({
    title: TITLE,
    author: AUTHOR,
    identifiers: []
  });

  expect(await identifierCount(target)).toBe(1);
  const claim = await pool.query(
    `SELECT language, published_date, pages, description
       FROM edition_identifier_info WHERE edition_uri = $1 AND issuer = 'isbn13' AND value = $2`,
    [target, ISBN]
  );
  expect(claim.rows[0]).toEqual({
    language: 'en',
    published_date: '1969-03-01',
    pages: 304,
    description: 'A cold planet and an envoy.'
  });

  const row = await ledger(target);
  expect(row.outcome).toBe('found');
  expect(row.source).toBe('openlibrary');
  expect(row.isbn).toBe(ISBN);

  // The identifier trigger is what queues the republication; the task writes no
  // outbox row itself, so this proves the trigger saw the insert.
  const outbox = await pool.query(
    `SELECT count(*)::int AS count FROM pds_outbox WHERE uri = $1`,
    [target]
  );
  expect(outbox.rows[0].count, 'the edition is queued for republication').toBeGreaterThan(0);
});

test('a second run is idempotent: no duplicate identifier, no duplicate claim', async () => {
  const target = await claimedBook('idempotent');
  const { registry } = stubProviders({ candidates: [candidate({ isbn13: IDEMPOTENT_ISBN })] });
  const tasks = tasksFor(registry);

  await tasks['catalog.isbn.backfill']({ editionUri: target }, { logger: log });
  const second = await tasks['catalog.isbn.backfill']({ editionUri: target }, { logger: log });

  expect(second).toEqual({ status: 'skipped' });
  expect(await identifierCount(target)).toBe(1);
  const info = await pool.query(
    'SELECT count(*)::int AS count FROM edition_identifier_info WHERE edition_uri = $1',
    [target]
  );
  expect(info.rows[0].count).toBe(1);
  expect((await ledger(target)).outcome, 'the last run had nothing to do').toBe('skipped');
});

test('an ISBN another edition already owns is a conflict and writes nothing', async () => {
  const owner = await claimedBook('conflict-owner', { isbn: CONFLICT_ISBN });
  const target = await claimedBook('conflict-target');
  const { registry } = stubProviders({ candidates: [candidate({ isbn13: CONFLICT_ISBN })] });

  const result = await tasksFor(registry)['catalog.isbn.backfill'](
    { editionUri: target },
    { logger: log }
  );

  expect(result).toEqual({ status: 'conflict', isbn: CONFLICT_ISBN, source: 'openlibrary' });
  expect(await identifierCount(target), 'the target gains no identifier').toBe(0);
  expect(await identifierCount(owner)).toBe(1);
  const info = await pool.query(
    'SELECT count(*)::int AS count FROM edition_identifier_info WHERE edition_uri = $1',
    [target]
  );
  expect(info.rows[0].count).toBe(0);

  const row = await ledger(target);
  expect(row.outcome).toBe('conflict');
  expect(row.isbn).toBe(CONFLICT_ISBN);
  expect(row.source).toBe('openlibrary');
});

test('an ISBN-10 another edition owns is the same conflict as its ISBN-13', async () => {
  const pairIsbn13 = '9780553293357';
  const pairIsbn10 = '0553293354';
  const owner = await claimedBook('isbn10-owner');
  await pool.query(
    `INSERT INTO edition_identifiers (edition_uri, issuer, value)
     VALUES ($1, 'isbn10', $2)`,
    [owner, pairIsbn10]
  );
  const target = await claimedBook('isbn10-target');
  const { registry } = stubProviders({ candidates: [candidate({ isbn13: pairIsbn13 })] });

  const result = await tasksFor(registry)['catalog.isbn.backfill'](
    { editionUri: target },
    { logger: log }
  );

  expect(result).toEqual({ status: 'conflict', isbn: pairIsbn13, source: 'openlibrary' });
  expect(await identifierCount(target), 'the target gains no identifier').toBe(0);
  expect((await ledger(target)).isbn, 'the evidence names the ISBN-13').toBe(pairIsbn13);
});

test('an answer with no acceptable candidate is recorded as none', async () => {
  const target = await claimedBook('none');
  const { registry } = stubProviders({
    candidates: [candidate({ title: 'The Right Hand of Daylight' })]
  });

  const result = await tasksFor(registry)['catalog.isbn.backfill'](
    { editionUri: target },
    { logger: log }
  );

  expect(result).toEqual({ status: 'none' });
  expect(await identifierCount(target)).toBe(0);
  expect((await ledger(target)).outcome).toBe('none');
});

test('a provider outage propagates so the job retries and files no absence', async () => {
  const target = await claimedBook('outage');
  const { registry } = stubProviders({ error: new Error('openlibrary down') });

  await expect(
    tasksFor(registry)['catalog.isbn.backfill']({ editionUri: target }, { logger: log })
  ).rejects.toThrow('openlibrary down');

  expect((await ledger(target)).outcome, 'the claim is kept, no outcome is written').toBe(
    'skipped'
  );
});

test('the daily budget refuses before a provider is asked, and one below it still spends', async () => {
  // Today's real attempts are whatever the earlier tests in this file spent;
  // the fixture adds one of its own and the budget is read back, so the
  // comparison is exact rather than assumed.
  await claimedBook('budget-spent');
  await pool.query(
    `UPDATE edition_isbn_backfill
        SET outcome = 'found', requested_at = now()
      WHERE edition_uri = $1`,
    [uri('budget-spent')]
  );
  const spent = await pool.query(
    `SELECT count(*)::int AS count FROM edition_isbn_backfill
      WHERE requested_at >= date_trunc('day', now())
        AND outcome IN ('found', 'none', 'conflict')`
  );
  const budget = spent.rows[0].count;

  const target = await claimedBook('budget-target');
  const { registry, calls } = stubProviders({ candidates: [candidate({ isbn13: BUDGET_ISBN })] });

  const refused = await tasksFor(registry, { isbnBackfillPerDay: budget })[
    'catalog.isbn.backfill'
  ]({ editionUri: target }, { logger: log });

  expect(refused).toEqual({ status: 'budget' });
  expect(calls.openlibrary.length + calls.goodreads.length + calls.google.length).toBe(0);
  expect((await ledger(target)).outcome, 'a refused attempt is not an outcome').toBe('skipped');

  const allowed = await tasksFor(registry, { isbnBackfillPerDay: budget + 1 })[
    'catalog.isbn.backfill'
  ]({ editionUri: target }, { logger: log });

  expect(allowed, 'one attempt below the ceiling still spends').toEqual({
    status: 'found',
    isbn: BUDGET_ISBN,
    source: 'openlibrary'
  });
});
