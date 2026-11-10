import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { prefetchContributors } from './contributor-name-resolver';
import { db } from '../db';
import { contributors } from '../db/schema';

const log = pino({ level: 'silent' });

// Used as a deterministic, namespaced author name for these tests so we don't
// collide with real seed data. The slug collapses to `name-resolver-test-author`.
const TEST_AUTHOR = 'Name Resolver Test Author';

/** Resolve a name the way every caller does: prefetch the page, then read it. */
async function resolveNames(
  names: string[],
  source: 'googlebooks' | 'isbndb' | 'bookhive',
) {
  const resolver = await prefetchContributors(names, source, log);
  return resolver.resolve(names);
}

// Wipe any pre-existing rows for the test author across both source prefixes.
async function cleanup(): Promise<void> {
  await db.delete(contributors).where(eq(contributors.name, TEST_AUTHOR));
}

test('prefetchContributors returns one strongRef per name', async () => {
  await cleanup();
  try {
    const entries = await resolveNames([TEST_AUTHOR], 'googlebooks');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'author');
    assert.match(entries[0]?.subject.uri ?? '', /\/gb\.a-name-resolver-test-author$/);
    assert.match(entries[0]?.subject.cid ?? '', /^bafy/);
  } finally {
    await cleanup();
  }
});

test('prefetchContributors reuses the same row on second call', async () => {
  await cleanup();
  try {
    const first = await resolveNames([TEST_AUTHOR], 'googlebooks');
    const second = await resolveNames([TEST_AUTHOR, TEST_AUTHOR], 'googlebooks');
    assert.equal(first.length, 1);
    assert.equal(first[0]?.subject.cid, second[0]?.subject.cid);
    assert.equal(second.length, 2);
    assert.equal(second[0]?.subject.cid, second[1]?.subject.cid);
  } finally {
    await cleanup();
  }
});

test('prefetchContributors consolidates across sources via name match', async () => {
  await cleanup();
  try {
    const gb = await resolveNames([TEST_AUTHOR], 'googlebooks');
    const isbndb = await resolveNames([TEST_AUTHOR], 'isbndb');
    // The isbndb call should fall back to the case-insensitive name match
    // the gb call wrote, so both resolve to the same row (same uri+cid).
    assert.equal(gb[0]?.subject.uri, isbndb[0]?.subject.uri);
    assert.equal(gb[0]?.subject.cid, isbndb[0]?.subject.cid);
  } finally {
    await cleanup();
  }
});

test('prefetchContributors skips empty / whitespace names', async () => {
  const entries = await resolveNames(
    ['', '   ', undefined as unknown as string],
    'googlebooks',
  );
  assert.deepEqual(entries, []);
});

test('prefetchContributors stubs a whole page in one write', async () => {
  const second = 'Name Resolver Test Author Two';
  await db.delete(contributors).where(eq(contributors.name, second));
  await cleanup();
  try {
    const names = [TEST_AUTHOR, second];
    const resolver = await prefetchContributors(names, 'googlebooks', log);
    const entries = await resolver.resolve(names);
    assert.equal(entries.length, 2);
    const stored = await db
      .select({ uri: contributors.uri })
      .from(contributors)
      .where(eq(contributors.name, second));
    assert.equal(stored.length, 1, 'the stub for the second name was persisted');
  } finally {
    await db.delete(contributors).where(eq(contributors.name, second));
    await cleanup();
  }
});

test('bookhive stubs are keyed bh.a-<slug>', async () => {
  await cleanup();
  try {
    const entries = await resolveNames([TEST_AUTHOR], 'bookhive');
    assert.equal(entries.length, 1);
    assert.match(entries[0]?.subject.uri ?? '', /\/bh\.a-name-resolver-test-author$/);
  } finally {
    await cleanup();
  }
});
