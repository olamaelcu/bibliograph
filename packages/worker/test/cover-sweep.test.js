import { expect, test } from 'vitest';

import { createTasks, COVER_SWEEP_BATCH, COVER_SWEEP_BATCH_MAX } from '../lib/tasks.js';

const PASS = 'catalog.covers.sweep';
const log = { info() {}, warn() {}, error() {} };

/**
 * A sweep-only task registry over a scripted `pool.query`.
 *
 * The sweep makes four kinds of call: the uncached pass (a source URL with no
 * cached file), the never-attempted pass, the retry pass, and one claim for the
 * whole batch of queued editions. Each is answered from the script and
 * recorded, so the test asserts the priority split without a database.
 */
function sweepPool({
  uncached = [],
  fresh = [],
  retries = [],
  claimed = true,
  coversCacheDir = '/srv/covers'
} = {}) {
  const calls = { uncached: [], fresh: [], retries: [], claims: [] };
  const pool = {
    query: async (sql, values) => {
      if (sql.includes('catalog_enqueue_cover_fetch')) {
        const uris = values[0];
        calls.claims.push(...uris);
        return {
          rows: uris.map((uri) => ({
            enqueued: typeof claimed === 'function' ? claimed(uri) : claimed
          }))
        };
      }
      // Ordered routing: the retry pass is driven by the ledger's own clock, the
      // uncached pass joins the cache table, and what is left is the plain
      // `editions` walk.
      if (sql.includes('ORDER BY l.requested_at')) {
        calls.retries.push(values[0]);
        return { rows: retries.slice(0, values[0]).map((uri) => ({ uri })) };
      }
      if (sql.includes('edition_cover_files f')) {
        calls.uncached.push(values[0]);
        return { rows: uncached.slice(0, values[0]).map((uri) => ({ uri })) };
      }
      calls.fresh.push(values[0]);
      return { rows: fresh.slice(0, values[0]).map((uri) => ({ uri })) };
    }
  };
  // The sweep only enqueues and never touches the directory, so any configured
  // path enables the pass; the value itself is irrelevant here.
  const tasks = createTasks({
    pool,
    providers: {},
    publisherHost: 'sweep.example',
    coversCacheDir
  });
  return { tasks: { sweep: tasks[PASS] }, calls };
}

test('uncached editions come first, then new ones, then retries with the remainder', async () => {
  const { tasks, calls } = sweepPool({
    uncached: ['at://cached/1', 'at://cached/2'],
    fresh: ['at://new/1'],
    retries: ['at://old/1', 'at://old/2', 'at://old/3']
  });

  await tasks.sweep({ limit: 5 }, { logger: log });

  expect(calls.uncached, 'the backfill pass asks for the full limit').toEqual([5]);
  expect(calls.fresh, 'new editions get what the backfill left').toEqual([3]);
  expect(calls.retries, 'retries only get what is left').toEqual([2]);
  expect(calls.claims).toEqual([
    'at://cached/1',
    'at://cached/2',
    'at://new/1',
    'at://old/1',
    'at://old/2'
  ]);
});

test('a saturated backfill pass never runs the later passes', async () => {
  const { tasks, calls } = sweepPool({
    uncached: ['at://cached/1', 'at://cached/2'],
    fresh: ['at://new/1'],
    retries: ['at://old/1']
  });

  await tasks.sweep({ limit: 2 }, { logger: log });

  expect(calls.uncached).toEqual([2]);
  expect(calls.fresh, 'no `LIMIT 0` query is issued').toEqual([]);
  expect(calls.retries).toEqual([]);
  expect(calls.claims).toEqual(['at://cached/1', 'at://cached/2']);
});

test('a saturated new pass starves retries by design', async () => {
  const { tasks, calls } = sweepPool({
    uncached: [],
    fresh: ['at://new/1', 'at://new/2'],
    retries: ['at://old/1']
  });

  await tasks.sweep({ limit: 2 }, { logger: log });

  expect(calls.uncached).toEqual([2]);
  expect(calls.fresh).toEqual([2]);
  expect(calls.retries, 'retries are not in addition to new work').toEqual([]);
  expect(calls.claims).toEqual(['at://new/1', 'at://new/2']);
});

test('a pass that answers nothing leaves the whole budget to the next one', async () => {
  const { tasks, calls } = sweepPool({ uncached: [], fresh: [], retries: ['at://old/1'] });

  await tasks.sweep({ limit: 5 }, { logger: log });

  expect(calls.uncached).toEqual([5]);
  expect(calls.fresh).toEqual([5]);
  expect(calls.retries, 'retries get the full limit instead').toEqual([5]);
  expect(calls.claims).toEqual(['at://old/1']);
});

test('the sweep bounds its limit whatever the payload asks for', async () => {
  const cases = [
    [{ limit: 5000 }, COVER_SWEEP_BATCH_MAX],
    [{ limit: 0 }, 1],
    [{ limit: -3 }, 1],
    [{ limit: 3.5 }, COVER_SWEEP_BATCH],
    [{}, COVER_SWEEP_BATCH],
    [undefined, COVER_SWEEP_BATCH]
  ];

  for (const [payload, expected] of cases) {
    const { tasks, calls } = sweepPool({ uncached: ['at://cached/1'] });
    await tasks.sweep(payload, { logger: log });
    expect(calls.uncached, `payload ${JSON.stringify(payload)}`).toEqual([expected]);
  }
});

test('only a real claim counts as enqueued', async () => {
  const lines = [];
  const logger = { info: (line) => lines.push(line), warn() {}, error() {} };
  const { tasks } = sweepPool({
    uncached: ['at://cached/1'],
    fresh: ['at://new/1'],
    claimed: (uri) => uri === 'at://cached/1'
  });

  await tasks.sweep({ limit: 2 }, { logger });

  expect(lines).toEqual([
    'catalog.covers.sweep: 2 candidate(s) (1 uncached, 1 new, 0 retry), 1 enqueued'
  ]);
});

test('an unset COVERS_CACHE_DIR makes the sweep a no-op instead of a guess', async () => {
  const lines = [];
  const logger = { info() {}, warn: (line) => lines.push(line), error() {} };
  const { tasks, calls } = sweepPool({ uncached: ['at://cached/1'], coversCacheDir: '' });

  await tasks.sweep({ limit: 5 }, { logger });

  expect(calls).toEqual({ uncached: [], fresh: [], retries: [], claims: [] });
  expect(lines).toEqual(['catalog.covers.sweep: COVERS_CACHE_DIR is not set, skipping']);
});
