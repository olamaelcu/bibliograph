import test from 'node:test';
import assert from 'node:assert/strict';

import { createTasks, GENRE_SWEEP_BATCH, GENRE_SWEEP_BATCH_MAX } from '../lib/tasks.js';

const PASS_ONE = 'catalog.genres.sweep';
const log = { info() {}, warn() {}, error() {} };

/**
 * A sweep-only task registry over a scripted `pool.query`.
 *
 * The sweep makes three kinds of call: the never-attempted pass, the retry
 * pass, and one claim per queued edition. Each is answered from the script and
 * recorded, so the test asserts the priority split without a database.
 */
function sweepPool({ fresh = [], retries = [], claimed = true } = {}) {
  const calls = { fresh: [], retries: [], claims: [] };
  const pool = {
    query: async (sql, values) => {
      if (sql.includes('catalog_enqueue_genre_fetch')) {
        const uri = values[0];
        calls.claims.push(uri);
        return { rows: [{ enqueued: typeof claimed === 'function' ? claimed(uri) : claimed }] };
      }
      // The retry pass is driven by the ledger and ordered by its clock; the
      // first pass is an `indexed_at` walk over `editions`.
      if (!sql.includes('ORDER BY f.requested_at')) {
        calls.fresh.push(values[0]);
        return { rows: fresh.map((uri) => ({ uri })) };
      }
      calls.retries.push(values[0]);
      return { rows: retries.map((uri) => ({ uri })) };
    }
  };
  const tasks = createTasks({ pool, providers: {}, publisherHost: 'sweep.example' });
  return { tasks: { sweep: tasks[PASS_ONE] }, calls };
}

test('the sweep fills from never-attempted editions and gives retries only the remainder', async () => {
  const { tasks, calls } = sweepPool({
    fresh: ['at://new/1', 'at://new/2'],
    retries: ['at://old/1', 'at://old/2', 'at://old/3']
  });

  await tasks.sweep({ limit: 5 }, { logger: log });

  assert.deepEqual(calls.fresh, [5], 'the first pass asks for the full limit');
  assert.deepEqual(calls.retries, [3], 'the retry pass asks only for what is left');
  assert.deepEqual(calls.claims, [
    'at://new/1',
    'at://new/2',
    'at://old/1',
    'at://old/2',
    'at://old/3'
  ]);
});

test('a saturated first pass never runs the retry query', async () => {
  const { tasks, calls } = sweepPool({
    fresh: ['at://new/1', 'at://new/2'],
    retries: ['at://old/1']
  });

  await tasks.sweep({ limit: 2 }, { logger: log });

  assert.deepEqual(calls.fresh, [2]);
  assert.deepEqual(calls.retries, [], 'retries are starved by design, not in addition to new work');
  assert.deepEqual(calls.claims, ['at://new/1', 'at://new/2']);
});

test('the sweep bounds its limit whatever the payload asks for', async () => {
  const cases = [
    [{ limit: 5000 }, GENRE_SWEEP_BATCH_MAX],
    [{ limit: 0 }, 1],
    [{ limit: -3 }, 1],
    [{ limit: 3.5 }, GENRE_SWEEP_BATCH],
    [{}, GENRE_SWEEP_BATCH],
    [undefined, GENRE_SWEEP_BATCH]
  ];

  for (const [payload, expected] of cases) {
    const { tasks, calls } = sweepPool();
    await tasks.sweep(payload, { logger: log });
    assert.deepEqual(calls.fresh, [expected], `payload ${JSON.stringify(payload)}`);
  }
});

test('only a real claim counts as enqueued', async () => {
  const lines = [];
  const logger = { info: (line) => lines.push(line), warn() {}, error() {} };
  const { tasks } = sweepPool({
    fresh: ['at://new/1', 'at://new/2'],
    claimed: (uri) => uri === 'at://new/1'
  });

  await tasks.sweep({ limit: 2 }, { logger });

  assert.deepEqual(lines, [
    'catalog.genres.sweep: 2 candidate(s) (2 new, 0 retry), 1 enqueued'
  ]);
});
