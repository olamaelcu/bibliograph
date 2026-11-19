#!/usr/bin/env node
/**
 * One-shot: fill the external search index from Postgres, then apply queued
 * changes.
 *
 * This is deliberately not a worker task. It runs whenever an operator asks
 * for it — a deploy or a schema change must not wait for the 01:00–08:00
 * America/New_York worker window — and it is safe to interrupt: the snapshot is
 * a keyset walk over `books.uri`, so a rerun with `--after <last uri>` resumes
 * where it stopped, and posting a document twice replaces it.
 *
 *   1. snapshot: `search_documents(after, batch)` pages the whole catalog and
 *      posts each page as upserts;
 *   2. queue: `claim_search_dirty(batch)` reads the change queue, rebuilds the
 *      current document for upserts, posts deletes and upserts together, then
 *      acknowledges exactly the versions it applied.
 *
 * Usage:
 *   DATABASE_URL=… SEARCH_URL=http://127.0.0.1:3102 \
 *     node packages/worker/scripts/search-backfill.mjs
 *
 * Options:
 *   --after <uri>      resume the snapshot after this uri
 *   --max-batches <n>  stop after n batches (used to smoke-test)
 *   --dry-run          read Postgres, print counts, post nothing
 *   --snapshot-only    skip the queue drain
 *   --queue-only       skip the snapshot (drain queued changes only)
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const SEARCH_URL = (process.env.SEARCH_URL ?? 'http://127.0.0.1:3102').replace(/\/+$/, '');
const BATCH = Number(process.env.SEARCH_BACKFILL_BATCH ?? 2000);
const POST_TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    after: '',
    maxBatches: Number.POSITIVE_INFINITY,
    dryRun: false,
    snapshot: true,
    queue: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--snapshot-only') options.queue = false;
    else if (arg === '--queue-only') options.snapshot = false;
    else if (arg === '--after') options.after = argv[++i] ?? '';
    else if (arg === '--max-batches') options.maxBatches = Number(argv[++i]);
    else if (arg === '-h' || arg === '--help') {
      console.log('usage: search-backfill.mjs [--after URI] [--max-batches N] [--dry-run] [--snapshot-only] [--queue-only]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST a batch, retrying transient failures; throws after the last attempt. */
async function post(path, body) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${SEARCH_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await sleep(300 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/** Rows from `search_documents*` are already the index document shape. */
const toDoc = (row) => ({
  uri: row.uri,
  title: row.title,
  subtitle: row.subtitle,
  contributors: row.contributors ?? [],
  description: row.description,
  genres: row.genres ?? [],
  language: row.language,
  year: row.year
});

async function snapshot(pool, options) {
  let after = options.after;
  let docs = 0;
  let batches = 0;
  const started = Date.now();
  for (;;) {
    if (batches >= options.maxBatches) break;
    const { rows } = await pool.query('SELECT * FROM search_documents($1, $2)', [after, BATCH]);
    if (rows.length === 0) break;
    batches += 1;
    docs += rows.length;
    after = rows[rows.length - 1].uri;
    if (!options.dryRun) {
      await post('/docs', { upsert: rows.map(toDoc) });
    }
    const seconds = (Date.now() - started) / 1000;
    console.log(
      `snapshot: ${docs} docs, batch ${batches}, ${(docs / seconds).toFixed(0)} docs/s, last ${after}`
    );
  }
  return { docs, after, batches };
}

async function drain(pool, options) {
  let applied = 0;
  let batches = 0;
  let deletes = 0;
  const started = Date.now();
  for (;;) {
    if (batches >= options.maxBatches) break;
    const { rows } = await pool.query('SELECT * FROM claim_search_dirty($1)', [BATCH]);
    if (rows.length === 0) break;
    batches += 1;

    const deleteUris = rows.filter((row) => row.op === 'delete').map((row) => row.uri);
    const upsertUris = rows.filter((row) => row.op === 'upsert').map((row) => row.uri);
    let upserts = [];
    if (upsertUris.length > 0) {
      const current = await pool.query('SELECT * FROM search_documents_for($1::text[])', [upsertUris]);
      upserts = current.rows.map(toDoc);
    }

    if (!options.dryRun) {
      await post('/docs', { upsert: upserts, delete: deleteUris });
      const acked = await pool.query('SELECT ack_search_dirty($1::text[], $2::text[]) AS acked', [
        rows.map((row) => row.uri),
        rows.map((row) => row.changed_at)
      ]);
      // A claim that cannot be acknowledged would be re-read forever: stop and
      // say so instead of looping.
      if (Number(acked.rows[0]?.acked ?? 0) === 0) {
        throw new Error('ack applied nothing; the claimed versions did not match');
      }
    }

    applied += rows.length;
    deletes += deleteUris.length;
    const seconds = (Date.now() - started) / 1000;
    console.log(`queue: ${applied} changes (${deletes} deletes), last batch ${batches}, ${seconds.toFixed(1)}s`);
  }
  return { applied, deletes, batches };
}

const options = parseArgs(process.argv.slice(2));
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

/** The service is on loopback; a hang here means it is not answering, not slow. */
const healthz = async () =>
  (await fetch(`${SEARCH_URL}/healthz`, { signal: AbortSignal.timeout(5_000) })).json();

try {
  const health = await healthz();
  console.log(`search service: ${SEARCH_URL} docs=${health.docs}`);
  if (options.dryRun) console.log('dry run: nothing will be posted');

  if (options.snapshot) {
    const result = await snapshot(pool, options);
    console.log(
      `snapshot done: ${result.docs} docs in ${result.batches} batches; resume with --after "${result.after}"`
    );
  }
  if (options.queue) {
    const result = await drain(pool, options);
    console.log(`queue drained: ${result.applied} changes (${result.deletes} deletes)`);
  }

  const final = await healthz();
  console.log(`search service now: docs=${final.docs} segments=${final.segments}`);
} catch (error) {
  console.error(`failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
