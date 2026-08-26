import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { resolveOlContributors } from './open-library-contributors';

const log = pino({ level: 'silent' });

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, _init?: RequestInit) => impl(String(url))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

// DB hit: the row already exists, so resolveOlContributors returns its stored
// cid without touching OL. Maya Angelou (OL28885A) is seeded by the
// integration smoke and used by the local Postgres in mise dev.
test('resolveOlContributors returns the stored cid for an existing contributor', async () => {
  const { db } = await import('../db');
  const { contributors } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(contributors).where(eq(contributors.uri,
    'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.A28885',
  )).limit(1);
  if (!row) {
    // Local Postgres isn't seeded with Maya Angelou; integration test skipped.
    return;
  }
  const entries = await resolveOlContributors(['/authors/OL28885A'], log);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.role, 'author');
  assert.equal(entries[0]?.subject.uri, row.uri);
  assert.equal(entries[0]?.subject.cid, row.cid);
});

// DB miss + OL fetch: the row does not yet exist, so resolveOlContributors
// fetches `/authors/{olid}.json`, computes a fresh cid, and returns a
// strongRef pointing at the deterministic rkey. It also enqueues an async
// ingest into the DB (fire-and-forget).
test('resolveOlContributors fetches OL doc on miss and computes a fresh cid', async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes('/authors/OL999999A')) {
      return new Response(JSON.stringify({
        key: '/authors/OL999999A',
        name: 'Resolved Test Author',
        alternate_names: ['RTA'],
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
  // Wipe any pre-existing row from a previous run so the miss path is exercised.
  const { db } = await import('../db');
  const { contributors } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const uri = 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.A999999A';
  await db.delete(contributors).where(eq(contributors.uri, uri));

  try {
    const entries = await resolveOlContributors(['/authors/OL999999A'], log);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'author');
    assert.equal(entries[0]?.subject.uri, uri);
    assert.ok(entries[0]?.subject.cid, 'cid should be computed');
    assert.match(entries[0]?.subject.cid ?? '', /^bafy/);
  } finally {
    restore();
    // Best-effort cleanup so the row doesn't leak across runs.
    await db.delete(contributors).where(eq(contributors.uri, uri));
  }
});

// Invalid key: skips without throwing.
test('resolveOlContributors skips malformed keys without throwing', async () => {
  const entries = await resolveOlContributors(['garbage', '', '/works/OL1W'], log);
  assert.deepEqual(entries, []);
});
