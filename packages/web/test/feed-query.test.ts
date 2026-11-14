import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOK_STATUS_COLLECTION,
  FEED_KINDS,
  REVIEW_COLLECTION,
  decodeCursor,
  encodeCursor,
  feedDids,
  fetchFeedPage,
  normalizeFollowSubject,
  reasonFor,
  type Queryable
} from '../src/lib/server/feeds/query.ts';

/**
 * Feed page assembly with a fake pool: ordering/cursor contract, per-feed DID
 * scoping, and reason resolution. SQL itself is exercised against the local
 * database by the live smoke test; these tests pin the params and the mapping.
 */

type Call = { sql: string; values?: unknown[] };

function queuedPool(batches: unknown[][]): Queryable & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: batches.shift() ?? [] };
    }
  };
}

function row(
  uri: string,
  collection: string,
  record: Record<string, unknown>,
  created_at: string | null
) {
  return { uri, collection, record, created_at };
}

test('pages public records and emits a cursor only when the probe row exists', async () => {
  const pool = queuedPool([
    [
      row('at://a/review/3', REVIEW_COLLECTION, { createdAt: '2026-03-03T00:00:00.000Z' }, '2026-03-03T00:00:00.000Z'),
      row('at://a/status/2', BOOK_STATUS_COLLECTION, { createdAt: '2026-03-02T00:00:00.000Z' }, '2026-03-02T00:00:00.000Z'),
      row('at://a/review/1', REVIEW_COLLECTION, { createdAt: '2026-03-01T00:00:00.000Z' }, '2026-03-01T00:00:00.000Z')
    ]
  ]);

  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 2 });

  assert.equal(page.feed.length, 2);
  assert.deepEqual(
    page.feed.map((item) => item.post),
    ['at://a/review/3', 'at://a/status/2']
  );
  assert.ok(page.cursor);
  assert.deepEqual(decodeCursor(page.cursor), {
    c: '2026-03-02T00:00:00.000Z',
    u: 'at://a/status/2'
  });
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0]!.values?.[0], REVIEW_COLLECTION);
  assert.equal(pool.calls[0]!.values?.[1], BOOK_STATUS_COLLECTION);
  assert.equal(pool.calls[0]!.values?.at(-1), 3);
});

test('does not emit a cursor when the page is not full', async () => {
  const pool = queuedPool([
    [row('at://a/review/1', REVIEW_COLLECTION, { createdAt: '2026-03-01T00:00:00.000Z' }, '2026-03-01T00:00:00.000Z')]
  ]);
  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });
  assert.equal(page.cursor, undefined);
});

test('passes the keyset cursor values and keeps a null createdAt tail reachable', async () => {
  const cursor = { c: '2026-03-02T00:00:00.000Z', u: 'at://a/status/2' };
  const pool = queuedPool([
    [row('at://a/review/1', REVIEW_COLLECTION, {}, '2026-03-01T00:00:00.000Z')]
  ]);

  await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 5, cursor });

  const values = pool.calls[0]!.values ?? [];
  assert.deepEqual(values.slice(-3), [cursor.c, cursor.u, 6]);
  assert.match(pool.calls[0]!.sql, /createdAt' IS NULL AND uri </);
});

test('reason prefers subjectRecord, then the first atproto identifier', () => {
  assert.equal(
    reasonFor(REVIEW_COLLECTION, {
      subjectRecord: 'at://did:plc:b/edition/1',
      subject: { identifiers: [{ issuer: 'atproto', value: 'at://did:plc:b/edition/2' }] }
    }),
    'at://did:plc:b/edition/1'
  );
  assert.equal(
    reasonFor(REVIEW_COLLECTION, {
      subject: {
        identifiers: [
          { issuer: 'isbn13', value: '9780306406157' },
          { issuer: 'atproto', value: 'at://did:plc:b/edition/2' }
        ]
      }
    }),
    'at://did:plc:b/edition/2'
  );
  assert.equal(reasonFor(REVIEW_COLLECTION, { subject: { identifiers: [] } }), undefined);
  assert.equal(
    reasonFor(BOOK_STATUS_COLLECTION, { book: { uri: 'at://did:plc:b/edition/3', cid: 'bafy' } }),
    'at://did:plc:b/edition/3'
  );
  assert.equal(reasonFor(BOOK_STATUS_COLLECTION, { book: {} }), undefined);
});

test('skeleton items omit reason when the record names no book', async () => {
  const pool = queuedPool([
    [row('at://a/review/1', REVIEW_COLLECTION, {}, '2026-03-01T00:00:00.000Z')]
  ]);
  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });
  assert.deepEqual(page.feed, [{ post: 'at://a/review/1' }]);
});

test('following scopes the page to the viewer follow set', async () => {
  const pool = queuedPool([
    [{ did: 'did:plc:one' }, { did: 'did:plc:two' }],
    [row('at://did:plc:one/review/1', REVIEW_COLLECTION, {}, '2026-03-01T00:00:00.000Z')]
  ]);

  const page = await fetchFeedPage(pool, {
    kind: 'following',
    viewerDid: 'did:plc:viewer',
    limit: 20
  });

  assert.equal(page.feed.length, 1);
  assert.match(pool.calls[0]!.sql, /did <> \$1/);
  assert.deepEqual(pool.calls[1]!.values?.[2], ['did:plc:one', 'did:plc:two']);
});

test('normalizes bare and at:// follow subjects without a migration', async () => {
  assert.equal(normalizeFollowSubject('did:plc:one'), 'did:plc:one');
  assert.equal(normalizeFollowSubject('at://did:plc:one'), 'did:plc:one');
  assert.equal(normalizeFollowSubject('at://did:web:example.test'), 'did:web:example.test');
  assert.equal(normalizeFollowSubject('https://example.test'), null);
  assert.equal(normalizeFollowSubject('at://not-a-did'), null);
  assert.equal(normalizeFollowSubject(42), null);

  // Livtet's writer stores `at://did:...`; the SQL strips it and the row
  // mapper repeats the normalization, so both writers land in one DID set.
  const pool = queuedPool([[{ did: 'at://did:plc:one' }, { did: 'did:plc:two' }], []]);
  const dids = await feedDids(pool, 'following', 'did:plc:viewer');
  assert.deepEqual(dids, ['did:plc:one', 'did:plc:two']);
  assert.match(pool.calls[0]!.sql, /WHEN subject LIKE 'at:\/\/%' THEN substr\(subject, 6\)/);
  assert.match(pool.calls[0]!.sql, /did LIKE 'did:%'/);
});

test('extended adds the followees of followees with the 500-DID cap', async () => {
  const pool = queuedPool([
    [{ did: 'did:plc:one' }, { did: 'did:plc:two' }],
    []
  ]);

  await fetchFeedPage(pool, { kind: 'extended', viewerDid: 'did:plc:viewer', limit: 20 });

  assert.match(pool.calls[0]!.sql, /hop1 AS \(/);
  assert.match(pool.calls[0]!.sql, /LIMIT \$3/);
  assert.match(pool.calls[0]!.sql, /r\.record::jsonb->>'subject' LIKE 'at:\/\/%'/);
  assert.match(pool.calls[0]!.sql, /substr\(r\.record::jsonb->>'subject', 6\)/);
  assert.equal(pool.calls[0]!.values?.[2], 500);
  assert.deepEqual(pool.calls[1]!.values?.[2], ['did:plc:one', 'did:plc:two']);
});

test('dynamic is the viewer plus the follow set', async () => {
  const pool = queuedPool([
    [{ did: 'did:plc:one' }, { did: 'did:plc:two' }],
    []
  ]);

  const dids = await feedDids(pool, 'dynamic', 'did:plc:viewer');
  assert.deepEqual(dids, ['did:plc:viewer', 'did:plc:one', 'did:plc:two']);
});

test('an empty follow set returns an empty page without a second query', async () => {
  const pool = queuedPool([[]]);
  const page = await fetchFeedPage(pool, {
    kind: 'following',
    viewerDid: 'did:plc:viewer',
    limit: 20
  });
  assert.deepEqual(page, { feed: [] });
  assert.equal(pool.calls.length, 1);
});

test('cursors are strict base64url JSON {c,u}', () => {
  assert.deepEqual(decodeCursor(encodeCursor({ c: 'x', u: 'at://a/b/1' })), {
    c: 'x',
    u: 'at://a/b/1'
  });
  assert.deepEqual(decodeCursor(encodeCursor({ c: null, u: 'at://a/b/1' })), {
    c: null,
    u: 'at://a/b/1'
  });

  const cases = [
    'not base64!',
    Buffer.from('[]').toString('base64url'),
    Buffer.from('{"u":"at://a/b/1"}').toString('base64url'),
    Buffer.from('{"c":1,"u":"at://a/b/1"}').toString('base64url'),
    Buffer.from('{"c":"x"}').toString('base64url'),
    Buffer.from('{"c":"x","u":""}').toString('base64url')
  ];
  for (const value of cases) assert.equal(decodeCursor(value), null, value);
});

test('reports follow-set and page phases once each, and only page for public', async () => {
  const followingEvents: string[] = [];
  const followingDids: number[] = [];
  const durations: number[] = [];
  const followingPool = queuedPool([
    [{ did: 'did:plc:one' }, { did: 'at://did:plc:two' }],
    [row('at://did:plc:one/review/1', REVIEW_COLLECTION, {}, '2026-03-01T00:00:00.000Z')]
  ]);

  await fetchFeedPage(followingPool, {
    kind: 'following',
    viewerDid: 'did:plc:viewer',
    limit: 20,
    observe: (observation) => {
      followingEvents.push(observation.event);
      durations.push(observation.durationSeconds);
      if (observation.event === 'follow_dids') followingDids.push(observation.dids);
    }
  });

  assert.deepEqual(followingEvents, ['follow_dids', 'page']);
  assert.deepEqual(followingDids, [2]);
  for (const duration of durations) assert.equal(typeof duration, 'number');

  const publicEvents: string[] = [];
  const publicPool = queuedPool([[row('at://a/review/1', REVIEW_COLLECTION, {}, null)]]);
  await fetchFeedPage(publicPool, {
    kind: 'public',
    viewerDid: null,
    limit: 20,
    observe: (observation) => publicEvents.push(observation.event)
  });
  assert.deepEqual(publicEvents, ['page']);
});

test('advertises exactly the four documented feeds and no recommendations', () => {
  const kinds: readonly string[] = FEED_KINDS;
  assert.deepEqual(kinds, ['public', 'following', 'extended', 'dynamic']);
  assert.equal(kinds.includes('recommendations'), false);
});
