// Regression: ID-based lookup of editions by contributor at-uri. The new
// `community.lexicon.book.getEditionsByContributor` XRPC must return only
// editions whose stored `contributors` JSONB contains the given
// `subject.uri`, ordered by `published_year DESC NULLS LAST, indexed_at DESC`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { editions } from '../db/schema';
import { findEditionUrisByContributor } from './postgres-source';

const CONTRIBUTOR_URI = 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/test-find-by-contrib';
const A_URI = 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/test-find-by-contrib-a';
const B_URI = 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/test-find-by-contrib-b';
const C_URI = 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/test-find-by-contrib-c';

async function seedFixtures(): Promise<void> {
  await db.delete(editions).where(eq(editions.rkey, 'test-find-by-contrib-a'));
  await db.delete(editions).where(eq(editions.rkey, 'test-find-by-contrib-b'));
  await db.delete(editions).where(eq(editions.rkey, 'test-find-by-contrib-c'));

  await db.insert(editions).values([
    {
      uri: A_URI,
      cid: 'bafya',
      did: 'did:web:biblio.livtet.olamaelcu.net',
      rkey: 'test-find-by-contrib-a',
      title: 'Edition A — matches contributor',
      subtitle: null,
      place: null,
      publishedYear: 1996,
      language: 'en',
      contributors: [{ subject: { uri: CONTRIBUTOR_URI, cid: 'bafyca' }, role: 'author' }],
      identifiers: [{ uri: 'isbn:9780000000001', resource: 'isbn13' }],
      description: null,
      coverImageUrl: null,
      createdAt: new Date('2020-01-01T00:00:00Z'),
    },
    {
      uri: B_URI,
      cid: 'bafyb',
      did: 'did:web:biblio.livtet.olamaelcu.net',
      rkey: 'test-find-by-contrib-b',
      title: 'Edition B — matches contributor, newer',
      subtitle: null,
      place: null,
      publishedYear: 2010,
      language: 'en',
      contributors: [{ subject: { uri: CONTRIBUTOR_URI, cid: 'bafycb' }, role: 'author' }],
      identifiers: [{ uri: 'isbn:9780000000002', resource: 'isbn13' }],
      description: null,
      coverImageUrl: null,
      createdAt: new Date('2020-01-02T00:00:00Z'),
    },
    {
      uri: C_URI,
      cid: 'bafyc',
      did: 'did:web:biblio.livtet.olamaelcu.net',
      rkey: 'test-find-by-contrib-c',
      title: 'Edition C — does NOT match',
      subtitle: null,
      place: null,
      publishedYear: 2024,
      language: 'en',
      contributors: [{ subject: { uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/some-other-author', cid: 'bafycc' }, role: 'author' }],
      identifiers: [{ uri: 'isbn:9780000000003', resource: 'isbn13' }],
      description: null,
      coverImageUrl: null,
      createdAt: new Date('2020-01-03T00:00:00Z'),
    },
  ]);
}

async function cleanup(): Promise<void> {
  await db.delete(editions).where(eq(editions.rkey, 'test-find-by-contrib-a'));
  await db.delete(editions).where(eq(editions.rkey, 'test-find-by-contrib-b'));
  await db.delete(editions).where(eq(editions.rkey, 'test-find-by-contrib-c'));
}

test('findEditionUrisByContributor returns only editions whose contributors JSONB contains the subject.uri', async () => {
  await seedFixtures();
  try {
    const uris = await findEditionUrisByContributor(CONTRIBUTOR_URI, 10);
    assert.equal(uris.length, 2);
    assert.ok(uris.includes(A_URI));
    assert.ok(uris.includes(B_URI));
    assert.ok(!uris.includes(C_URI));
  } finally {
    await cleanup();
  }
});

test('findEditionUrisByContributor orders by published_year DESC NULLS LAST', async () => {
  await seedFixtures();
  try {
    const uris = await findEditionUrisByContributor(CONTRIBUTOR_URI, 10);
    assert.deepEqual(uris, [B_URI, A_URI], 'newer (2010) before older (1996)');
  } finally {
    await cleanup();
  }
});

test('findEditionUrisByContributor respects limit', async () => {
  await seedFixtures();
  try {
    const uris = await findEditionUrisByContributor(CONTRIBUTOR_URI, 1);
    assert.equal(uris.length, 1);
    assert.equal(uris[0], B_URI, 'newer edition wins when limited');
  } finally {
    await cleanup();
  }
});

test('findEditionUrisByContributor returns empty for unknown contributor', async () => {
  const uris = await findEditionUrisByContributor('at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/never-existed', 10);
  assert.deepEqual(uris, []);
});
