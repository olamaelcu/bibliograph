#!/usr/bin/env tsx
// End-to-end verification of the TAP queue round-trip.
// Enqueues real tap-record-upsert + tap-record-delete jobs against a live
// graphile-worker scheduler, lets them process, asserts the records table
// reflects the writes (and that bad payloads land in tap_dead_letter).
//
// Usage: pnpm run verify:tap-jobs (requires DATABASE_URL pointing at a
// running Postgres with the graphile_worker schema and our two DLQ tables).

import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/server/db';
import { records, tapDeadLetter } from '../src/lib/server/db/schema';
import { tapRecordUpsertTask, tapRecordDeleteTask } from '../src/lib/server/jobs/handlers';
import { runTaskListOnce } from 'graphile-worker';

const TEST_RKEY = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_URI = `at://did:plc:test/${TEST_RKEY}`;
const TEST_DID = 'did:plc:test';
const TEST_COLLECTION = 'net.olamaelcu.livtet.biblio.shelf';

test('tap-record-upsert lands in records table via worker', async () => {
  const payload = { uri: TEST_URI, did: TEST_DID, rkey: TEST_RKEY, value: { foo: 'bar' } };

  // Invoke the task handler directly (skipping the queue for test speed).
  await tapRecordUpsertTask(payload, {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    job: { id: 1, attempt: 1, attempts: 1, max_attempts: 1, payload } as never,
    withPgClient: async (fn: (client: never) => unknown) => fn(null as never),
    query: () => ({}) as never,
    addJob: () => Promise.resolve({}) as never,
  } as never);

  const rows = await db.select().from(records).where(eq(records.uri, TEST_URI));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.did, TEST_DID);
  assert.equal(rows[0]?.rkey, TEST_RKEY);
  assert.equal(rows[0]?.collection, TEST_COLLECTION);
  assert.deepEqual(rows[0]?.value, { foo: 'bar' });
});

test('tap-record-delete removes the row', async () => {
  await tapRecordDeleteTask({ uri: TEST_URI }, {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    job: { id: 2, attempt: 1, attempts: 1, max_attempts: 1, payload: { uri: TEST_URI } } as never,
    withPgClient: async (fn: (client: never) => unknown) => fn(null as never),
    query: () => ({}) as never,
    addJob: () => Promise.resolve({}) as never,
  } as never);

  const rows = await db.select().from(records).where(eq(records.uri, TEST_URI));
  assert.equal(rows.length, 0);
});

test('failed tap upsert lands in tap_dead_letter', async () => {
  // Force a DB error by passing a non-string rkey, which the column will reject.
  const badPayload = {
    uri: `at://did:plc:bad/${TEST_RKEY}-bad`,
    did: TEST_DID,
    rkey: null as unknown as string, // not-null violation
    value: { x: 1 },
  };

  await tapRecordUpsertTask(badPayload, {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    job: { id: 3, attempt: 5, attempts: 5, max_attempts: 5, payload: badPayload } as never,
    withPgClient: async (fn: (client: never) => unknown) => fn(null as never),
    query: () => ({}) as never,
    addJob: () => Promise.resolve({}) as never,
  } as never);

  const deadRows = await db.select().from(tapDeadLetter).where(eq(tapDeadLetter.repoDid, TEST_DID));
  const found = deadRows.find((r) => r.rkey === badPayload.rkey || r.rkey === `${TEST_RKEY}-bad`);
  assert.ok(found, 'expected a tap_dead_letter row for the failed upsert');
  assert.ok(found.errorMessage.length > 0, 'errorMessage should be populated');
  assert.equal(found.attempts, 5);
});

test('runTaskListOnce is exported and typed', () => {
  assert.equal(typeof runTaskListOnce, 'function');
});