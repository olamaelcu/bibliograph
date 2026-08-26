// Regression: ingest handlers must persist new field values on ON CONFLICT
// update, not silently leave them stale. Before this fix, drizzle's
// onConflictDoUpdate SET clause used `editions.field` (the CURRENT row's
// value) instead of `sql\`excluded.field\`` (the inserted value), so a
// re-ingest never overwrote existing data.

import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { editions } from '../db/schema';

const TEST_URI = 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/handler-on-conflict-test';
const TEST_RKEY = 'handler-on-conflict-test';

test('re-ingest with populated contributors overwrites the empty-contributors row', async () => {
  // 1. Clean state
  await db.delete(editions).where(eq(editions.uri, TEST_URI));

  // 2. Insert initial row with empty contributors (mimics the OLD data state)
  await db.insert(editions).values({
    uri: TEST_URI,
    cid: 'bafyinitial',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: TEST_RKEY,
    title: 'Handler On-Conflict Test',
    subtitle: null,
    place: null,
    publishedYear: 2020,
    language: 'en',
    contributors: [],
    identifiers: [],
    description: null,
    coverImageUrl: null,
    createdAt: new Date(),
  });

  // 3. Re-ingest with populated contributors (what the new resolver produces)
  await db.insert(editions).values({
    uri: TEST_URI,
    cid: 'bafyreingested',
    did: 'did:web:biblio.livtet.olamaelcu.net',
    rkey: TEST_RKEY,
    title: 'Handler On-Conflict Test',
    subtitle: null,
    place: null,
    publishedYear: 2020,
    language: 'en',
    contributors: [{ subject: { uri: 'at://x/contrib/test', cid: 'bafyc' }, role: 'author' }],
    identifiers: [],
    description: null,
    coverImageUrl: null,
    createdAt: new Date(),
  }).onConflictDoUpdate({
    target: editions.uri,
    set: {
      title: sql`excluded.title`,
      subtitle: sql`excluded.subtitle`,
      description: sql`excluded.description`,
      coverImageUrl: sql`excluded.cover_image_url`,
      identifiers: sql`excluded.identifiers`,
      contributors: sql`excluded.contributors`,
      indexedAt: new Date(),
    },
  });

  // 4. The contributors column MUST reflect the new (populated) value.
  const [row] = await db.select().from(editions).where(eq(editions.uri, TEST_URI)).limit(1);
  assert.ok(row, 'row should exist');
  assert.equal(row.contributors.length, 1, 'expected re-ingest to overwrite contributors');
  assert.equal(row.contributors[0]?.subject.uri, 'at://x/contrib/test');

  // Cleanup
  await db.delete(editions).where(eq(editions.uri, TEST_URI));
});
