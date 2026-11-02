import test from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { newestRecordFirst, recordSortKeyOf } from './record-recency';

const dialect = new PgDialect();

function compiled(fragment: SQL) {
  const { sql, params } = dialect.sqlToQuery(fragment);
  return { sql: sql.replace(/\s+/g, ' '), params };
}

test('recency order is the generated column, with the uri tiebreak', () => {
  const { sql } = compiled(newestRecordFirst());

  assert.match(sql, /"records"\."record_created_at" desc, "records"\."uri" desc$/);
});

test('recency order touches neither the jsonb nor the mirror indexing time', () => {
  const { sql } = compiled(newestRecordFirst());

  // Sorting on `value->>'createdAt'` is what made every feed request a sequential
  // scan: the cast is STABLE, so it can be neither generated nor indexed.
  assert.doesNotMatch(sql, /value/);
  // `indexed_at` is when the mirror wrote the row, not when the record was made.
  assert.doesNotMatch(sql, /indexed_at/);
});

test('the row key is the column key, verbatim', () => {
  // Fraction digits survive as written: re-serialising through `Date` would
  // truncate microseconds and the cursor would compare unlike keys.
  assert.equal(
    recordSortKeyOf({ value: { createdAt: '2026-11-02T16:47:44.739Z' } }),
    '2026-11-02T16:47:44.739Z',
  );
  assert.equal(
    recordSortKeyOf({ value: { createdAt: '2026-11-02T16:47:44.739123Z' } }),
    '2026-11-02T16:47:44.739123Z',
  );
});

test('a record without a createdAt gets the blank key the column generates', () => {
  assert.equal(recordSortKeyOf({ value: {} }), '');
  assert.equal(recordSortKeyOf({ value: null }), '');
  assert.equal(recordSortKeyOf({ value: { createdAt: null } }), '');
});

test('a non-string scalar is read the way jsonb ->> reads it', () => {
  assert.equal(recordSortKeyOf({ value: { createdAt: 42 } }), '42');
  assert.equal(recordSortKeyOf({ value: { createdAt: true } }), 'true');
});
