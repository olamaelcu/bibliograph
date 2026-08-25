#!/usr/bin/env tsx
// End-to-end verification of the TAP record queue round-trip.
// Requires DATABASE_URL pointing at a database with graphile_worker._jobs,
// records, ingest_dead_letter, and tap_dead_letter tables.

import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/lib/server/db';
import { records, tapDeadLetter } from '../src/lib/server/db/schema';
import {
  tapRecordUpsertTask,
  tapRecordDeleteTask,
  tapRecordUpsertBatchTask,
  tapRecordDeleteBatchTask,
} from '../src/lib/server/jobs/handlers';
import { getTapQueueDepth } from '../src/lib/server/jobs/depth';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const TEST_URI = 'at://did:plc:test/TapTestCollection/rec1';
const BATCH_URIS = [
  'at://did:plc:batch/TapTestCollection/rec-b1',
  'at://did:plc:batch/TapTestCollection/rec-b2',
  'at://did:plc:batch/TapTestCollection/rec-b3',
];

function fakeHelpers() {
  return {
    job: { id: '1', taskIdentifier: 'tap-record-upsert', attempts: 1, maxAttempts: 1, runAt: new Date() },
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: function () { return this; } },
    withPgClient: async () => {},
    addJob: async () => '0',
  } as never;
}

test('tap-record-upsert writes to records table', async () => {
  await db.delete(records).where(eq(records.uri, TEST_URI));
  await tapRecordUpsertTask(
    { uri: TEST_URI, did: 'did:plc:test', rkey: 'rec1', value: { displayName: 'Test' } },
    fakeHelpers(),
  );
  const rows = await db.select().from(records).where(eq(records.uri, TEST_URI)).limit(1);
  assert.equal(rows.length, 1, 'row should exist');
});

test('tap-record-delete removes the row', async () => {
  await tapRecordDeleteTask({ uri: TEST_URI }, fakeHelpers());
  const rows = await db.select().from(records).where(eq(records.uri, TEST_URI)).limit(1);
  assert.equal(rows.length, 0);
});

test('DLQ table exists and accepts inserts', async () => {
  await db.delete(tapDeadLetter).where(eq(tapDeadLetter.rkey, 'rec-dlq-smoke'));
  await db.insert(tapDeadLetter).values({
    repoDid: 'did:plc:smoke',
    collection: 'SmokeCollection',
    rkey: 'rec-dlq-smoke',
    payload: { foo: 'bar' },
    errorMessage: 'synthetic smoke test',
    attempts: 1,
  });
  const [dlq] = await db.select().from(tapDeadLetter).where(eq(tapDeadLetter.rkey, 'rec-dlq-smoke')).limit(1);
  assert.ok(dlq, 'DLQ row should exist');
  assert.equal(dlq.errorMessage, 'synthetic smoke test');
});

test('tap-record-upsert-batch writes multiple rows', async () => {
  for (const uri of BATCH_URIS) {
    await db.delete(records).where(eq(records.uri, uri));
  }
  await tapRecordUpsertBatchTask(
    [
      { uri: BATCH_URIS[0]!, did: 'did:plc:batch', rkey: 'rec-b1', value: { displayName: 'B1' } },
      { uri: BATCH_URIS[1]!, did: 'did:plc:batch', rkey: 'rec-b2', value: { displayName: 'B2' } },
      { uri: BATCH_URIS[2]!, did: 'did:plc:batch', rkey: 'rec-b3', value: { displayName: 'B3' } },
    ],
    fakeHelpers(),
  );
  const rows = await db.select().from(records).where(inArray(records.uri, BATCH_URIS));
  assert.equal(rows.length, 3, 'all 3 batch rows should exist');
});

test('tap-record-delete-batch removes multiple rows', async () => {
  await tapRecordDeleteBatchTask(BATCH_URIS, fakeHelpers());
  const rows = await db.select().from(records).where(inArray(records.uri, BATCH_URIS));
  assert.equal(rows.length, 0, 'all 3 batch rows should be removed');
});

test('getTapQueueDepth returns a non-negative number', async () => {
  const depth = await getTapQueueDepth();
  assert.ok(typeof depth === 'number');
  assert.ok(depth >= 0);
});