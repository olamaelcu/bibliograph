/**
 * `edition_isbn_backfill`'s claim function and the sweep that feeds it.
 *
 * The container has no `graphile_worker` schema (the worker creates it at
 * boot), so this file installs a stub `add_job` that records its arguments.
 * That is enough to assert the claim contract — one row, one job, a seven-day
 * retry window — against real SQL instead of a scripted pool.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import pg from 'pg';

import { createTasks } from '../lib/tasks.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = process.hrtime.bigint().toString(36);
const PREFIX = `at://did:plc:isbnledgerprobe/community.lexicon.media.book.edition/${RUN}`;
const uri = (suffix) => `${PREFIX}-${suffix}`;
const log = { info() {}, warn() {}, error() {} };

let pool;

async function addBook(suffix, { title = 'Roadside Picnic', isbn = null, indexedAt = null } = {}) {
  const target = uri(suffix);
  await pool.query(
    `INSERT INTO books (uri, title, created_at, indexed_at)
     VALUES ($1, $2, now(), COALESCE($3::timestamptz, now()))`,
    [target, title, indexedAt]
  );
  if (isbn) {
    await pool.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value)
       VALUES ($1, 'isbn13', $2)`,
      [target, isbn]
    );
  }
  return target;
}

async function claim(target) {
  const { rows } = await pool.query(
    'SELECT catalog_enqueue_isbn_backfill($1) AS enqueued',
    [target]
  );
  return rows[0].enqueued;
}

async function jobs(target) {
  const { rows } = await pool.query(
    `SELECT identifier, payload, queue_name, job_key, max_attempts, priority
       FROM isbn_backfill_test_jobs
      WHERE job_key = $1
      ORDER BY id`,
    [`isbn-backfill:${target}`]
  );
  return rows;
}

async function ledger(target) {
  const { rows } = await pool.query(
    `SELECT outcome, source, isbn, requested_at < now() - interval '1 second' AS backdated
       FROM edition_isbn_backfill WHERE edition_uri = $1`,
    [target]
  );
  return rows[0];
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  // Stand-in for the schema graphile-worker creates at boot; the migration only
  // resolves `add_job` when it is called, so installing it later is fine.
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS graphile_worker;
    CREATE TABLE IF NOT EXISTS isbn_backfill_test_jobs (
      id bigserial PRIMARY KEY,
      identifier text,
      payload jsonb,
      queue_name text,
      job_key text,
      max_attempts integer,
      priority integer
    );
    CREATE OR REPLACE FUNCTION graphile_worker.add_job(
      identifier text = NULL,
      payload json = NULL,
      queue_name text = NULL,
      run_at timestamp with time zone = now(),
      max_attempts integer = 25,
      job_key text = NULL,
      priority integer = NULL
    ) RETURNS void LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO isbn_backfill_test_jobs
             (identifier, payload, queue_name, job_key, max_attempts, priority)
      VALUES (identifier, payload, queue_name, job_key, max_attempts, priority);
    END;
    $fn$;
  `);
});

afterAll(async () => {
  await pool.query('DELETE FROM books WHERE uri LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM isbn_backfill_test_jobs WHERE job_key LIKE $1', [
    `isbn-backfill:${PREFIX}%`
  ]);
  await pool.end();
});

test('the first claim writes a skipped ledger row and one serialised job', async () => {
  const target = await addBook('claim');

  expect(await claim(target)).toBe(true);

  const row = await ledger(target);
  expect(row.outcome, 'no NULL state: the claim itself is `skipped`').toBe('skipped');
  expect(row.source).toBeNull();
  expect(row.isbn).toBeNull();

  const queued = await jobs(target);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toEqual({
    identifier: 'catalog.isbn.backfill',
    payload: { editionUri: target },
    // One job per queue at a time is graphile-worker's concurrency 1.
    queue_name: 'isbn-backfill',
    job_key: `isbn-backfill:${target}`,
    max_attempts: 3,
    // Bulk work: the per-edition class, behind edge-triggered hydration.
    priority: 100
  });
});

test('a second claim inside the seven-day window queues nothing', async () => {
  const target = await addBook('window');
  expect(await claim(target)).toBe(true);

  await pool.query(
    `UPDATE edition_isbn_backfill
        SET requested_at = now() - interval '6 days', outcome = 'none'
      WHERE edition_uri = $1`,
    [target]
  );

  expect(await claim(target)).toBe(false);
  expect((await ledger(target)).outcome, 'the refused claim leaves the outcome alone').toBe('none');
  expect(await jobs(target)).toHaveLength(1);
});

test('a row older than seven days is claimed again and its evidence is cleared', async () => {
  const target = await addBook('retry');
  expect(await claim(target)).toBe(true);
  await pool.query(
    `UPDATE edition_isbn_backfill
        SET requested_at = now() - interval '8 days',
            outcome = 'found',
            source = 'openlibrary',
            isbn = '9780441478125'
      WHERE edition_uri = $1`,
    [target]
  );

  expect(await claim(target)).toBe(true);

  const row = await ledger(target);
  expect(row.outcome, 'the stale evidence belongs to the previous attempt').toBe('skipped');
  expect(row.source).toBeNull();
  expect(row.isbn).toBeNull();
  expect(row.backdated, 'the retry clock is refreshed').toBe(false);
  expect(await jobs(target)).toHaveLength(2);
});

test('the sweep queues ISBN-less editions and skips owned, fresh-ledger and retry-inside editions', async () => {
  const fresh = await addBook('sweep-new');
  const owned = await addBook('sweep-owned', { isbn: '9780441478125' });
  const inside = await addBook('sweep-inside');
  const retry = await addBook('sweep-retry');

  await pool.query(
    `INSERT INTO edition_isbn_backfill (edition_uri, requested_at, outcome)
     VALUES ($1, now(), 'none'), ($2, now() - interval '8 days', 'none')`,
    [inside, retry]
  );

  const tasks = createTasks({ pool, providers: {}, publisherHost: 'isbn.example' });
  await tasks['catalog.isbn.backfill.sweep']({ limit: 50 }, { logger: log });

  // The ledger cannot tell a pre-existing row from a claimed one, so the queued
  // jobs are what the assertions read: one per claimed edition, none otherwise.
  expect(await jobs(fresh), 'never attempted, ISBN-less: claimed').toHaveLength(1);
  expect(await jobs(retry), 'the retry window elapsed: claimed again').toHaveLength(1);
  expect(await jobs(owned), 'the edition already owns an ISBN').toHaveLength(0);
  expect(await jobs(inside), 'the ledger row is inside the seven-day window').toHaveLength(0);

  // A refused claim leaves the previous evidence untouched.
  expect((await ledger(inside)).outcome).toBe('none');
  expect((await ledger(fresh)).outcome).toBe('skipped');
});
