import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { resolveContributorsByName } from './contributor-name-resolver';
import { db } from '../db';
import { contributors } from '../db/schema';

const log = pino({ level: 'silent' });

// Used as a deterministic, namespaced author name for these tests so we don't
// collide with real seed data. The slug collapses to `name-resolver-test-author`.
const TEST_AUTHOR = 'Name Resolver Test Author';

// Wipe any pre-existing rows for the test author across both source prefixes.
async function cleanup(): Promise<void> {
  await db.delete(contributors).where(eq(contributors.name, TEST_AUTHOR));
}

test('resolveContributorsByName returns one strongRef per name', async () => {
  await cleanup();
  try {
    const entries = await resolveContributorsByName([TEST_AUTHOR], 'googlebooks', log);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'author');
    assert.match(entries[0]?.subject.uri ?? '', /\/gb\.a-name-resolver-test-author$/);
    assert.match(entries[0]?.subject.cid ?? '', /^bafy/);
  } finally {
    await cleanup();
  }
});

test('resolveContributorsByName reuses the same row on second call', async () => {
  await cleanup();
  try {
    const first = await resolveContributorsByName([TEST_AUTHOR], 'googlebooks', log);
    const second = await resolveContributorsByName([TEST_AUTHOR, TEST_AUTHOR], 'googlebooks', log);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.subject.cid, second[0]?.subject.cid);
    assert.equal(second.length, 2);
    assert.equal(second[0]?.subject.cid, second[1]?.subject.cid);
  } finally {
    await cleanup();
  }
});

test('resolveContributorsByName consolidates across sources via name match', async () => {
  await cleanup();
  try {
    const gb = await resolveContributorsByName([TEST_AUTHOR], 'googlebooks', log);
    const isbndb = await resolveContributorsByName([TEST_AUTHOR], 'isbndb', log);
    // The isbndb call should fall back to the case-insensitive name match
    // the gb call wrote, so both resolve to the same row (same uri+cid).
    assert.equal(gb[0]?.subject.uri, isbndb[0]?.subject.uri);
    assert.equal(gb[0]?.subject.cid, isbndb[0]?.subject.cid);
  } finally {
    await cleanup();
  }
});

test('resolveContributorsByName skips empty / whitespace names', async () => {
  const entries = await resolveContributorsByName(['', '   ', undefined as unknown as string], 'googlebooks', log);
  assert.deepEqual(entries, []);
});
