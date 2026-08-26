// Regression: the platform's BookContributorSchema rejects anything that
// doesn't have `bookUri` + `contributor` + `role` per entry. Until this
// helper existed, the XRPC `com.atproto.repo.getRecord` handler passed the
// internal `ContributionEntry` shape straight through, which failed
// schema validation on the platform side and surfaced as HTTP 502.

import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { contributors } from './db/schema';
import { buildBookContributorViews } from './book-contributor-view';

const SEED_NAME = 'BookContributorView Test Author';
const SEED_URI = 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/bcv-test-a';

test('buildBookContributorViews returns empty for empty input', async () => {
  assert.deepEqual(await buildBookContributorViews('at://book', []), []);
  assert.deepEqual(await buildBookContributorViews('at://book', null), []);
  assert.deepEqual(await buildBookContributorViews('at://book', undefined), []);
});

test('buildBookContributorViews skips entries whose subject is missing from the contributors table', async () => {
  const result = await buildBookContributorViews(
    'at://book/missing',
    [{ subject: { uri: 'at://nope/contrib/missing', cid: 'x' }, role: 'author' }],
  );
  assert.deepEqual(result, []);
});

test('buildBookContributorViews emits the platform BookContributorView shape', async () => {
  // Seed a contributor row
  await db.delete(contributors).where(eq(contributors.uri, SEED_URI));
  await db.insert(contributors).values({
    uri: SEED_URI,
    cid: 'bafyseedcid',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: 'bcv-test-a',
    name: SEED_NAME,
    aliases: [],
    linkedDid: null,
    bio: null,
    bornYear: null,
    diedYear: null,
    identifiers: [{ uri: 'https://openlibrary.org/authors/OL0001A', resource: 'openlibrary' }],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  try {
    const result = await buildBookContributorViews(
      'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/bcv-test',
      [
        { subject: { uri: SEED_URI, cid: 'bafyseedcid' }, role: 'author' },
      ],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.bookUri, 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/bcv-test');
    assert.equal(result[0]?.role, 'author');
    assert.equal(result[0]?.contributor.uri, SEED_URI);
    assert.equal(result[0]?.contributor.name, SEED_NAME);
    assert.deepEqual(result[0]?.contributor.identifiers, [
      { uri: 'https://openlibrary.org/authors/OL0001A', resource: 'openlibrary' },
    ]);
    assert.equal(result[0]?.contributor.createdAt, '2026-01-01T00:00:00.000Z');
  } finally {
    await db.delete(contributors).where(eq(contributors.uri, SEED_URI));
  }
});
