import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOK_STATUS_COLLECTION,
  BUZZ_BOOKHIVE_BOOK,
  FEED_KINDS,
  POPFEED_LIST_ITEM_COLLECTION,
  POPFEED_REVIEW_COLLECTION,
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
  created_at: string | null,
  book_uri: string | null = null
) {
  return { uri, collection, record, created_at, book_uri };
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
  assert.equal(pool.calls[0]!.values?.[2], BUZZ_BOOKHIVE_BOOK);
  assert.equal(pool.calls[0]!.values?.[3], POPFEED_REVIEW_COLLECTION);
  assert.equal(pool.calls[0]!.values?.[4], POPFEED_LIST_ITEM_COLLECTION);
  assert.equal(pool.calls[0]!.values?.at(-1), 3);
});

test('does not emit a cursor when the page is not full', async () => {
  const pool = queuedPool([
    [row('at://a/review/1', REVIEW_COLLECTION, { createdAt: '2026-03-01T00:00:00.000Z' }, '2026-03-01T00:00:00.000Z')]
  ]);
  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });
  assert.equal(page.cursor, undefined);
});

test('passes the keyset cursor values and keeps the null-time tail reachable', async () => {
  const cursor = { c: '2026-03-02T00:00:00.000Z', u: 'at://a/status/2' };
  const pool = queuedPool([
    [row('at://a/review/1', REVIEW_COLLECTION, {}, '2026-03-01T00:00:00.000Z')]
  ]);

  await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 5, cursor });

  const values = pool.calls[0]!.values ?? [];
  assert.deepEqual(values.slice(-3), [cursor.c, cursor.u, 6]);
  // One expression orders, paces and reads the record's own activity time, so
  // an `addedAt`-only Popfeed row sorts with the rest of the page and a null
  // tail stays reachable on the next keyset step.
  assert.match(
    pool.calls[0]!.sql,
    /COALESCE\(record::jsonb->>'createdAt', record::jsonb->>'addedAt'\) IS NULL AND uri </
  );
  assert.match(pool.calls[0]!.sql, /ORDER BY COALESCE\(record::jsonb->>'createdAt', record::jsonb->>'addedAt'\) DESC NULLS LAST, uri DESC/);
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

test('a Bookhive entry carries its shelf and the edition its hive id resolved to', async () => {
  const edition = 'at://did:plc:pub/community.lexicon.media.book.edition/abc';
  const pool = queuedPool([
    [
      row(
        'at://did:plc:r/buzz.bookhive.book/1',
        BUZZ_BOOKHIVE_BOOK,
        { status: 'buzz.bookhive.defs#finished' },
        '2026-03-03T00:00:00.000Z',
        edition
      ),
      row(
        'at://did:plc:r/buzz.bookhive.book/2',
        BUZZ_BOOKHIVE_BOOK,
        { status: 'buzz.bookhive.defs#wantToRead' },
        '2026-03-02T00:00:00.000Z',
        edition
      )
    ]
  ]);

  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });

  assert.deepEqual(page.feed, [
    { post: 'at://did:plc:r/buzz.bookhive.book/1', reason: `bookhive:read|${edition}` },
    { post: 'at://did:plc:r/buzz.bookhive.book/2', reason: `bookhive:to-read|${edition}` }
  ]);
  const values = pool.calls[0]!.values ?? [];
  assert.deepEqual(values.slice(0, 3), [
    REVIEW_COLLECTION,
    BOOK_STATUS_COLLECTION,
    BUZZ_BOOKHIVE_BOOK
  ]);
  // One edition per hive id: the lookup is grouped, then joined on the page's
  // own ids, so a hive id that names several editions cannot multiply the row.
  assert.match(pool.calls[0]!.sql, /JOIN public\.appview_bookhive_lua m ON m\.hive_id = p\.hive_id/);
  assert.match(pool.calls[0]!.sql, /LEFT JOIN mapped ON mapped\.hive_id = p\.hive_id/);
});

test('a page never repeats a post, even when the row comes back twice', async () => {
  // Production served `buzz.bookhive.book/3n2f3…` twice — same cid, same
  // createdAt — every copy of it under a different edition: the lookup joined
  // one hive id to several imported editions. A repeat is not a second entry:
  // the client keys its rows by `post`, and Svelte's keyed each throws on the
  // collision, blanking the page. One row per post, and the probe row counted
  // after the collapse.
  const twice = row(
    'at://did:plc:r/buzz.bookhive.book/1',
    BUZZ_BOOKHIVE_BOOK,
    { createdAt: '2026-03-03T00:00:00.000Z', status: 'buzz.bookhive.defs#reading' },
    '2026-03-03T00:00:00.000Z',
    'at://did:plc:pub/community.lexicon.media.book.edition/a'
  );
  const other = row(
    'at://did:plc:r/buzz.bookhive.book/2',
    BUZZ_BOOKHIVE_BOOK,
    { createdAt: '2026-03-02T00:00:00.000Z', status: 'buzz.bookhive.defs#reading' },
    '2026-03-02T00:00:00.000Z',
    'at://did:plc:pub/community.lexicon.media.book.edition/b'
  );
  const pool = queuedPool([[twice, { ...twice, book_uri: 'at://did:plc:pub/community.lexicon.media.book.edition/other' }, other]]);

  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });

  assert.deepEqual(
    page.feed.map((item) => item.post),
    ['at://did:plc:r/buzz.bookhive.book/1', 'at://did:plc:r/buzz.bookhive.book/2']
  );
  // The first copy's reason stands: the duplicate editions collapsed to one
  // pick, not to a second row.
  assert.equal(page.feed[0]!.reason, 'bookhive:reading|at://did:plc:pub/community.lexicon.media.book.edition/a');
});

test('a duplicate row does not fake a next page', async () => {
  const only = row(
    'at://did:plc:r/review/1',
    REVIEW_COLLECTION,
    { createdAt: '2026-03-03T00:00:00.000Z' },
    '2026-03-03T00:00:00.000Z'
  );
  const pool = queuedPool([[only, only]]);

  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 1 });

  assert.equal(page.feed.length, 1);
  assert.equal(page.cursor, undefined);
});

test('the page query groups the edition lookup and dedupes by post', async () => {
  const pool = queuedPool([[]]);
  await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 5 });

  const sql = pool.calls[0]!.sql;
  // One edition per hive id: the view is many-to-one over `edition_identifiers`.
  assert.match(sql, /mapped AS \(\s*SELECT p\.hive_id, min\(m\.edition_uri\)/);
  assert.match(sql, /GROUP BY p\.hive_id/);
  assert.match(sql, /LEFT JOIN mapped ON mapped\.hive_id = p\.hive_id/);
  // The skeleton's contract, enforced where the page is built.
  assert.match(sql, /DISTINCT ON \(uri\)/);
});

test('a Bookhive entry with no imported edition still feeds with its shelf', async () => {
  const pool = queuedPool([
    [
      row(
        'at://did:plc:r/buzz.bookhive.book/1',
        BUZZ_BOOKHIVE_BOOK,
        { status: 'buzz.bookhive.defs#abandoned' },
        '2026-03-03T00:00:00.000Z'
      )
    ]
  ]);

  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });

  assert.deepEqual(page.feed, [
    { post: 'at://did:plc:r/buzz.bookhive.book/1', reason: 'bookhive:dnf' }
  ]);
});

test('a Bookhive status outside the known shelves still names the book', () => {
  const edition = 'at://did:plc:pub/community.lexicon.media.book.edition/abc';
  assert.equal(
    reasonFor(BUZZ_BOOKHIVE_BOOK, { status: 'buzz.bookhive.defs#paused' }, edition),
    `bookhive:|${edition}`
  );
  assert.equal(reasonFor(BUZZ_BOOKHIVE_BOOK, {}, null), 'bookhive:');
  // The two Bibliograph collections are unaffected by the third branch.
  assert.equal(reasonFor(BUZZ_BOOKHIVE_BOOK, null), undefined);
});

test('skeleton items omit reason when the record names no book', async () => {
  const pool = queuedPool([
    [row('at://a/review/1', REVIEW_COLLECTION, {}, '2026-03-01T00:00:00.000Z')]
  ]);
  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });
  assert.deepEqual(page.feed, [{ post: 'at://a/review/1' }]);
});

test('a Popfeed review carries the edition its ISBN resolved to', () => {
  const edition = 'at://did:plc:pub/community.lexicon.media.book.edition/pf';
  assert.equal(
    reasonFor(POPFEED_REVIEW_COLLECTION, { creativeWorkType: 'book', rating: 9 }, edition),
    `popfeed:review|${edition}`
  );
  // No catalog edition matched: the prefix stays, as it does for a Bookhive
  // record whose hive id was never imported, and the client falls back to the
  // record's own title and poster.
  assert.equal(reasonFor(POPFEED_REVIEW_COLLECTION, { creativeWorkType: 'book' }), 'popfeed:review');
  assert.equal(reasonFor(POPFEED_REVIEW_COLLECTION, null), undefined);
});

test('a Popfeed shelf entry carries its listType as a Livtet shelf', () => {
  const edition = 'at://did:plc:pub/community.lexicon.media.book.edition/pf';
  assert.equal(
    reasonFor(POPFEED_LIST_ITEM_COLLECTION, { listType: 'read_books' }, edition),
    `popfeed:read|${edition}`
  );
  assert.equal(reasonFor(POPFEED_LIST_ITEM_COLLECTION, { listType: 'to_read_books' }), 'popfeed:to-read');
  assert.equal(
    reasonFor(POPFEED_LIST_ITEM_COLLECTION, { listType: 'currently_reading_books' }, edition),
    `popfeed:reading|${edition}`
  );
  // The schema's `status` tokens are not what Popfeed writes, and a shelf the
  // feed does not page gets no reason.
  assert.equal(reasonFor(POPFEED_LIST_ITEM_COLLECTION, { status: '#finished' }), undefined);
  assert.equal(reasonFor(POPFEED_LIST_ITEM_COLLECTION, { listType: 'favorite_movies' }), undefined);
});

test('a Popfeed page resolves ISBN/ASIN to an edition and keeps its own time', async () => {
  const edition = 'at://did:plc:pub/community.lexicon.media.book.edition/pf';
  const unknown = 'at://did:plc:r/social.popfeed.feed.review/2';
  const pool = queuedPool([
    [
      row(
        'at://did:plc:r/social.popfeed.feed.listItem/1',
        POPFEED_LIST_ITEM_COLLECTION,
        { creativeWorkType: 'book', listType: 'read_books', identifiers: { isbn13: '9780306406157' } },
        '2026-03-03T00:00:00.000Z',
        edition
      ),
      // No edition matched the ISBN this record named.
      row(
        unknown,
        POPFEED_REVIEW_COLLECTION,
        { creativeWorkType: 'book', rating: 9, identifiers: { isbn13: '9780441478125' } },
        '2026-03-02T00:00:00.000Z'
      )
    ]
  ]);

  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });

  assert.deepEqual(page.feed, [
    { post: 'at://did:plc:r/social.popfeed.feed.listItem/1', reason: `popfeed:read|${edition}` },
    { post: unknown, reason: 'popfeed:review' }
  ]);

  const sql = pool.calls[0]!.sql;
  // Both Popfeed branches page book activity only, and the shelf branch reads
  // `listType` (never `status`) against the three book shelves.
  assert.match(sql, /AND record::jsonb->>'creativeWorkType' = 'book'/);
  assert.match(
    sql,
    /AND record::jsonb->>'listType' IN \('read_books', 'currently_reading_books', 'to_read_books'\)/
  );
  // The edition comes from `edition_identifiers` for the page's own Popfeed
  // rows, grouped so one ISBN naming several editions cannot fan a row out.
  assert.match(sql, /popfeed_keys AS \(/);
  assert.match(sql, /\('isbn13', p\.record->'identifiers'->>'isbn13'\)/);
  assert.match(sql, /\('isbn10', p\.record->'identifiers'->>'isbn10'\)/);
  assert.match(sql, /\('asin',   p\.record->'identifiers'->>'asin'\)/);
  assert.match(
    sql,
    /JOIN public\.edition_identifiers e ON e\.issuer = k\.issuer AND e\.value = k\.value/
  );
  assert.match(sql, /COALESCE\(mapped\.edition_uri, f\.edition_uri\) AS book_uri/);
  assert.match(sql, /LEFT JOIN popfeed f ON f\.uri = p\.uri/);
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
  // The page query's params are the five collections, then the follow set.
  assert.deepEqual(pool.calls[1]!.values?.[5], ['did:plc:one', 'did:plc:two']);
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
  assert.deepEqual(pool.calls[1]!.values?.[5], ['did:plc:one', 'did:plc:two']);
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
