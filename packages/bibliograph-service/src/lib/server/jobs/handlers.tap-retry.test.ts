// The TAP batch tasks used to dead-letter and return success on the first
// failure, so graphile never retried and nothing read the dead-letter table.
// These cases pin the retry contract: rethrow until the budget is spent, then
// one dead-letter insert for the whole batch, and never mirror a body-less event.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { records, tapDeadLetter } from '../db/schema';
import { MAX_TAP_ATTEMPTS } from './enqueue';
import { tapRecordUpsertBatchTask } from './handlers';

const log = pino({ level: 'silent' });
const ADMIN_DID = 'did:plc:tap-retry-test';

/** graphile's helper bag, reduced to what these tasks read. */
function helpersFor(attempts: number): Parameters<typeof tapRecordUpsertBatchTask>[1] {
  return { job: { attempts }, logger: log } as unknown as Parameters<typeof tapRecordUpsertBatchTask>[1];
}

/**
 * A row `records` rejects: `rkey` is NOT NULL, so the batch write throws while
 * the record's own uri still names a dead letter the table can store.
 */
function brokenItem(rkey: string) {
  return {
    uri: `at://${ADMIN_DID}/community.lexicon.book.edition/${rkey}`,
    did: ADMIN_DID,
    rkey: null,
    value: { title: 'retry contract' },
  };
}

async function clearDeadLetters(rkey: string): Promise<void> {
  await db.delete(tapDeadLetter).where(eq(tapDeadLetter.rkey, rkey));
}

test('a batch failure is retried before the budget is spent', async () => {
  const rkey = 'retry-contract-early';
  await clearDeadLetters(rkey);
  await assert.rejects(
    async () => {
      await tapRecordUpsertBatchTask([brokenItem(rkey)] as never, helpersFor(1));
    },
    'graphile must see the failure so it can retry',
  );
  const dead = await db.select().from(tapDeadLetter).where(eq(tapDeadLetter.rkey, rkey));
  assert.equal(dead.length, 0, 'nothing is dead-lettered while a retry remains');
  await clearDeadLetters(rkey);
});

test('the final attempt dead-letters the batch and stops retrying', async () => {
  const rkey = 'retry-contract-final';
  await clearDeadLetters(rkey);
  await assert.doesNotReject(
    async () => {
      await tapRecordUpsertBatchTask([brokenItem(rkey)] as never, helpersFor(MAX_TAP_ATTEMPTS));
    },
  );
  const dead = await db.select().from(tapDeadLetter).where(eq(tapDeadLetter.rkey, rkey));
  assert.equal(dead.length, 1, 'one dead letter per record, written once');
  assert.equal(dead[0]?.attempts, MAX_TAP_ATTEMPTS);
  await clearDeadLetters(rkey);
});

test('an event with no record body is not mirrored', async () => {
  const uri = `at://${ADMIN_DID}`;
  await db.delete(records).where(eq(records.uri, uri));
  // The uri names no collection or rkey, so the repo cannot be asked and the
  // event has to be skipped rather than written as `{}`.
  await assert.doesNotReject(
    async () => {
      await tapRecordUpsertBatchTask(
        [{ uri, did: ADMIN_DID, rkey: 'bodyless', value: {} }] as never,
        helpersFor(1),
      );
    },
  );
  const mirrored = await db.select({ uri: records.uri }).from(records).where(eq(records.uri, uri));
  assert.equal(mirrored.length, 0);
});
