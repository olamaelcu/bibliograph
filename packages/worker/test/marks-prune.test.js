import { expect, test } from 'vitest';

import { createTasks } from '../lib/tasks.js';

const TASK = 'catalog.marks.prune';

test('the prune deletes only marks older than a day and reports the count', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: [], rowCount: 7 };
    }
  };
  const tasks = createTasks({ pool, providers: {}, publisherHost: 'marks.example' });
  const lines = [];
  const logger = { info: (line) => lines.push(line), warn() {}, error() {} };

  await tasks[TASK](undefined, { logger });

  expect(queries.length, 'one statement: the table-wide DELETE').toBe(1);
  expect(queries[0].values, 'no parameters to bind').toEqual(undefined);
  // The window is the contract: the edge only reads marks inside its own
  // windows (an hour at most), so a day-old row is dead weight.
  expect(queries[0].sql).toMatch(/DELETE FROM catalog_enqueue_marks/);
  expect(queries[0].sql).toMatch(/enqueued_at < now\(\) - interval '24 hours'/);
  expect(lines).toEqual([`${TASK}: 7 mark(s) older than 24 h removed`]);
});
