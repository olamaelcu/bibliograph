import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCounts, type DbExecutor } from './stats';
import { works, editions, contributors, publishers } from './db/schema';

interface CallCapture {
  tables: unknown[];
}

interface FakeCountBuilder {
  select(): FakeCountBuilder;
  from(table: unknown): { then(onFulfilled: (v: unknown) => unknown): Promise<unknown> };
}

function createFakeDb(counts: Map<object, number>): { db: DbExecutor; capture: CallCapture } {
  const capture: CallCapture = { tables: [] };
  const builder: FakeCountBuilder = {
    select() { return builder; },
    from(table: unknown) {
      capture.tables.push(table);
      const c = counts.get(table as object) ?? 0;
      return {
        then(onFulfilled: (v: unknown) => unknown) {
          return Promise.resolve([{ c }]).then(onFulfilled as (v: unknown) => unknown);
        },
      };
    },
  };
  return { db: builder as unknown as DbExecutor, capture };
}

test('fetchCounts queries all four tables and returns numeric counts + ISO timestamp', async () => {
  const counts = new Map<object, number>([
    [works, 42],
    [editions, 117],
    [contributors, 9],
    [publishers, 3],
  ]);
  const { db, capture } = createFakeDb(counts);

  const result = await fetchCounts(db);

  assert.deepEqual(capture.tables, [works, editions, contributors, publishers]);
  assert.equal(result.works, 42);
  assert.equal(result.editions, 117);
  assert.equal(result.contributors, 9);
  assert.equal(result.publishers, 3);
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('fetchCounts falls back to 0 when the underlying query returns no rows', async () => {
  const { db, capture } = createFakeDb(new Map<object, number>());

  const result = await fetchCounts(db);

  assert.equal(capture.tables.length, 4);
  assert.equal(result.works, 0);
  assert.equal(result.editions, 0);
  assert.equal(result.contributors, 0);
  assert.equal(result.publishers, 0);
});