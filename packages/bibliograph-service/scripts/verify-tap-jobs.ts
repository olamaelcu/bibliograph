#!/usr/bin/env tsx
// End-to-end verification of the TAP record queue round-trip.
// Requires DATABASE_URL pointing at a database with graphile_worker._jobs,
// records, ingest_dead_letter, and tap_dead_letter tables.

import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/server/db';
import { records, tapDeadLetter } from '../src/lib/server/db/schema';
import { tapRecordUpsertTask, tapRecordDeleteTask } from '../src/lib/server/jobs/handlers';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const TEST_URI = 'at://did:plc:test/TapTestCollection/rec1';
const TEST_URI_BAD = 'at://did:plc:test/BadCollection/rec-bad';

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

test('failed upsert writes to tap_dead_letter', async () => {
  await db.delete(tapDeadLetter).where(eq(tapDeadLetter.rkey, 'rec-bad'));
  // Force a failure by passing a non-object value that breaks the JSONB column.
  try {
    await tapRecordUpsertTask(
      { uri: TEST_URI_BAD, did: 'did:plc:test', rkey: 'rec-bad', value: 'not-an-object' as never },
      fakeHelpers(),
    );
  } catch {
    // Handler catches and writes to DLQ; if it propagates that's also fine.
  }
  const [dlq] = await db.select().from(tapDeadLetter).where(eq(tapDeadLetter.rkey, 'rec-bad')).limit(1);
  assert.ok(dlq, 'failed row should land in tap_dead_letter');
});