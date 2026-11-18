import { expect, test } from 'vitest';

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

  expect(page.feed.length).toBe(2);
  expect(page.feed.map((item) => item.post)).toEqual(['at://a/review/3', 'at://a/status/2']);
  expect(page.cursor).toBeTruthy();
  expect(decodeCursor(page.cursor)).toEqual({
    c: '2026-03-02T00:00:00.000Z',
    u: 'at://a/status/2'
  });
  expect(pool.calls.length).toBe(1);
  expect(pool.calls[0]!.values?.[0]).toBe(REVIEW_COLLECTION);
  expect(pool.calls[0]!.values?.[1]).toBe(BOOK_STATUS_COLLECTION);
  expect(pool.calls[0]!.values?.[2]).toBe(BUZZ_BOOKHIVE_BOOK);
  expect(pool.calls[0]!.values?.[3]).toBe(POPFEED_REVIEW_COLLECTION);
  expect(pool.calls[0]!.values?.[4]).toBe(POPFEED_LIST_ITEM_COLLECTION);
  expect(pool.calls[0]!.values?.at(-1)).toBe(3);
});

test('does not emit a cursor when the page is not full', async () => {
  const pool = queuedPool([
    [row('at://a/review/1', REVIEW_COLLECTION, { createdAt: '2026-03-01T00:00:00.000Z' }, '2026-03-01T00:00:00.000Z')]
  ]);
  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });
  expect(page.cursor).toBe(undefined);
});

test('passes the keyset cursor values and keeps the null-time tail reachable', async () => {
  const cursor = { c: '2026-03-02T00:00:00.000Z', u: 'at://a/status/2' };
  const pool = queuedPool([
    [row('at://a/review/1', REVIEW_COLLECTION, {}, '2026-03-01T00:00:00.000Z')]
  ]);

  await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 5, cursor });

  const values = pool.calls[0]!.values ?? [];
  expect(values.slice(-3)).toEqual([cursor.c, cursor.u, 6]);
  // One expression orders, paces and reads the record's own activity time, so
  // an `addedAt`-only Popfeed row sorts with the rest of the page and a null
  // tail stays reachable on the next keyset step.
  expect(pool.calls[0]!.sql).toMatch(/COALESCE\(record::jsonb->>'createdAt', record::jsonb->>'addedAt'\) IS NULL AND uri </);
  expect(pool.calls[0]!.sql).toMatch(/ORDER BY COALESCE\(record::jsonb->>'createdAt', record::jsonb->>'addedAt'\) DESC NULLS LAST, uri DESC/);
});

test('reason prefers subjectRecord, then the first atproto identifier', () => {
  expect(reasonFor(REVIEW_COLLECTION, {
      subjectRecord: 'at://did:plc:b/edition/1',
      subject: { identifiers: [{ issuer: 'atproto', value: 'at://did:plc:b/edition/2' }] }
    })).toBe('at://did:plc:b/edition/1');
  expect(reasonFor(REVIEW_COLLECTION, {
      subject: {
        identifiers: [
          { issuer: 'isbn13', value: '9780306406157' },
          { issuer: 'atproto', value: 'at://did:plc:b/edition/2' }
        ]
      }
    })).toBe('at://did:plc:b/edition/2');
  expect(reasonFor(REVIEW_COLLECTION, { subject: { identifiers: [] } })).toBe(undefined);
  expect(reasonFor(BOOK_STATUS_COLLECTION, { book: { uri: 'at://did:plc:b/edition/3', cid: 'bafy' } })).toBe('at://did:plc:b/edition/3');
  expect(reasonFor(BOOK_STATUS_COLLECTION, { book: {} })).toBe(undefined);
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

  expect(page.feed).toEqual([
    { post: 'at://did:plc:r/buzz.bookhive.book/1', reason: `bookhive:read|${edition}` },
    { post: 'at://did:plc:r/buzz.bookhive.book/2', reason: `bookhive:to-read|${edition}` }
  ]);
  const values = pool.calls[0]!.values ?? [];
  expect(values.slice(0, 3)).toEqual([
    REVIEW_COLLECTION,
    BOOK_STATUS_COLLECTION,
    BUZZ_BOOKHIVE_BOOK
  ]);
  // One edition per hive id: the lookup is grouped, then joined on the page's
  // own ids, so a hive id that names several editions cannot multiply the row.
  expect(pool.calls[0]!.sql).toMatch(/JOIN public\.appview_bookhive_lua m ON m\.hive_id = p\.hive_id/);
  expect(pool.calls[0]!.sql).toMatch(/LEFT JOIN mapped ON mapped\.hive_id = p\.hive_id/);
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

  expect(page.feed.map((item) => item.post)).toEqual(['at://did:plc:r/buzz.bookhive.book/1', 'at://did:plc:r/buzz.bookhive.book/2']);
  // The first copy's reason stands: the duplicate editions collapsed to one
  // pick, not to a second row.
  expect(page.feed[0]!.reason).toBe('bookhive:reading|at://did:plc:pub/community.lexicon.media.book.edition/a');
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

  expect(page.feed.length).toBe(1);
  expect(page.cursor).toBe(undefined);
});

test('the page query groups the edition lookup and dedupes by post', async () => {
  const pool = queuedPool([[]]);
  await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 5 });

  const sql = pool.calls[0]!.sql;
  // One edition per hive id: the view is many-to-one over `edition_identifiers`.
  expect(sql).toMatch(/mapped AS \(\s*SELECT p\.hive_id, min\(m\.edition_uri\)/);
  expect(sql).toMatch(/GROUP BY p\.hive_id/);
  expect(sql).toMatch(/LEFT JOIN mapped ON mapped\.hive_id = p\.hive_id/);
  // The skeleton's contract, enforced where the page is built.
  expect(sql).toMatch(/DISTINCT ON \(uri\)/);
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

  expect(page.feed).toEqual([
    { post: 'at://did:plc:r/buzz.bookhive.book/1', reason: 'bookhive:dnf' }
  ]);
});

test('a Bookhive status outside the known shelves still names the book', () => {
  const edition = 'at://did:plc:pub/community.lexicon.media.book.edition/abc';
  expect(reasonFor(BUZZ_BOOKHIVE_BOOK, { status: 'buzz.bookhive.defs#paused' }, edition)).toBe(`bookhive:|${edition}`);
  expect(reasonFor(BUZZ_BOOKHIVE_BOOK, {}, null)).toBe('bookhive:');
  // The two Bibliograph collections are unaffected by the third branch.
  expect(reasonFor(BUZZ_BOOKHIVE_BOOK, null)).toBe(undefined);
});

test('skeleton items omit reason when the record names no book', async () => {
  const pool = queuedPool([
    [row('at://a/review/1', REVIEW_COLLECTION, {}, '2026-03-01T00:00:00.000Z')]
  ]);
  const page = await fetchFeedPage(pool, { kind: 'public', viewerDid: null, limit: 20 });
  expect(page.feed).toEqual([{ post: 'at://a/review/1' }]);
});

test('a Popfeed review carries the edition its ISBN resolved to', () => {
  const edition = 'at://did:plc:pub/community.lexicon.media.book.edition/pf';
  expect(reasonFor(POPFEED_REVIEW_COLLECTION, { creativeWorkType: 'book', rating: 9 }, edition)).toBe(`popfeed:review|${edition}`);
  // No catalog edition matched: the prefix stays, as it does for a Bookhive
  // record whose hive id was never imported, and the client falls back to the
  // record's own title and poster.
  expect(reasonFor(POPFEED_REVIEW_COLLECTION, { creativeWorkType: 'book' })).toBe('popfeed:review');
  expect(reasonFor(POPFEED_REVIEW_COLLECTION, null)).toBe(undefined);
});

test('a Popfeed shelf entry carries its listType as a Livtet shelf', () => {
  const edition = 'at://did:plc:pub/community.lexicon.media.book.edition/pf';
  expect(reasonFor(POPFEED_LIST_ITEM_COLLECTION, { listType: 'read_books' }, edition)).toBe(`popfeed:read|${edition}`);
  expect(reasonFor(POPFEED_LIST_ITEM_COLLECTION, { listType: 'to_read_books' })).toBe('popfeed:to-read');
  expect(reasonFor(POPFEED_LIST_ITEM_COLLECTION, { listType: 'currently_reading_books' }, edition)).toBe(`popfeed:reading|${edition}`);
  // The schema's `status` tokens are not what Popfeed writes, and a shelf the
  // feed does not page gets no reason.
  expect(reasonFor(POPFEED_LIST_ITEM_COLLECTION, { status: '#finished' })).toBe(undefined);
  expect(reasonFor(POPFEED_LIST_ITEM_COLLECTION, { listType: 'favorite_movies' })).toBe(undefined);
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

  expect(page.feed).toEqual([
    { post: 'at://did:plc:r/social.popfeed.feed.listItem/1', reason: `popfeed:read|${edition}` },
    { post: unknown, reason: 'popfeed:review' }
  ]);

  const sql = pool.calls[0]!.sql;
  // Both Popfeed branches page book activity only, and the shelf branch reads
  // `listType` (never `status`) against the three book shelves.
  expect(sql).toMatch(/AND record::jsonb->>'creativeWorkType' = 'book'/);
  expect(sql).toMatch(/AND record::jsonb->>'listType' IN \('read_books', 'currently_reading_books', 'to_read_books'\)/);
  // The edition comes from `edition_identifiers` for the page's own Popfeed
  // rows, grouped so one ISBN naming several editions cannot fan a row out.
  expect(sql).toMatch(/popfeed_keys AS \(/);
  expect(sql).toMatch(/\('isbn13', p\.record->'identifiers'->>'isbn13'\)/);
  expect(sql).toMatch(/\('isbn10', p\.record->'identifiers'->>'isbn10'\)/);
  expect(sql).toMatch(/\('asin',   p\.record->'identifiers'->>'asin'\)/);
  expect(sql).toMatch(/JOIN public\.edition_identifiers e ON e\.issuer = k\.issuer AND e\.value = k\.value/);
  expect(sql).toMatch(/COALESCE\(mapped\.edition_uri, f\.edition_uri\) AS book_uri/);
  expect(sql).toMatch(/LEFT JOIN popfeed f ON f\.uri = p\.uri/);
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

  expect(page.feed.length).toBe(1);
  expect(pool.calls[0]!.sql).toMatch(/did <> \$1/);
  // The page query's params are the five collections, then the follow set.
  expect(pool.calls[1]!.values?.[5]).toEqual(['did:plc:one', 'did:plc:two']);
});

test('normalizes bare and at:// follow subjects without a migration', async () => {
  expect(normalizeFollowSubject('did:plc:one')).toBe('did:plc:one');
  expect(normalizeFollowSubject('at://did:plc:one')).toBe('did:plc:one');
  expect(normalizeFollowSubject('at://did:web:example.test')).toBe('did:web:example.test');
  expect(normalizeFollowSubject('https://example.test')).toBe(null);
  expect(normalizeFollowSubject('at://not-a-did')).toBe(null);
  expect(normalizeFollowSubject(42)).toBe(null);

  // Livtet's writer stores `at://did:...`; the SQL strips it and the row
  // mapper repeats the normalization, so both writers land in one DID set.
  const pool = queuedPool([[{ did: 'at://did:plc:one' }, { did: 'did:plc:two' }], []]);
  const dids = await feedDids(pool, 'following', 'did:plc:viewer');
  expect(dids).toEqual(['did:plc:one', 'did:plc:two']);
  expect(pool.calls[0]!.sql).toMatch(/WHEN subject LIKE 'at:\/\/%' THEN substr\(subject, 6\)/);
  expect(pool.calls[0]!.sql).toMatch(/did LIKE 'did:%'/);
});

test('extended adds the followees of followees with the 500-DID cap', async () => {
  const pool = queuedPool([
    [{ did: 'did:plc:one' }, { did: 'did:plc:two' }],
    []
  ]);

  await fetchFeedPage(pool, { kind: 'extended', viewerDid: 'did:plc:viewer', limit: 20 });

  expect(pool.calls[0]!.sql).toMatch(/hop1 AS \(/);
  expect(pool.calls[0]!.sql).toMatch(/LIMIT \$3/);
  expect(pool.calls[0]!.sql).toMatch(/r\.record::jsonb->>'subject' LIKE 'at:\/\/%'/);
  expect(pool.calls[0]!.sql).toMatch(/substr\(r\.record::jsonb->>'subject', 6\)/);
  expect(pool.calls[0]!.values?.[2]).toBe(500);
  expect(pool.calls[1]!.values?.[5]).toEqual(['did:plc:one', 'did:plc:two']);
});

test('dynamic is the viewer plus the follow set', async () => {
  const pool = queuedPool([
    [{ did: 'did:plc:one' }, { did: 'did:plc:two' }],
    []
  ]);

  const dids = await feedDids(pool, 'dynamic', 'did:plc:viewer');
  expect(dids).toEqual(['did:plc:viewer', 'did:plc:one', 'did:plc:two']);
});

test('an empty follow set returns an empty page without a second query', async () => {
  const pool = queuedPool([[]]);
  const page = await fetchFeedPage(pool, {
    kind: 'following',
    viewerDid: 'did:plc:viewer',
    limit: 20
  });
  expect(page).toEqual({ feed: [] });
  expect(pool.calls.length).toBe(1);
});

test('cursors are strict base64url JSON {c,u}', () => {
  expect(decodeCursor(encodeCursor({ c: 'x', u: 'at://a/b/1' }))).toEqual({
    c: 'x',
    u: 'at://a/b/1'
  });
  expect(decodeCursor(encodeCursor({ c: null, u: 'at://a/b/1' }))).toEqual({
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
  for (const value of cases) expect(decodeCursor(value), value).toBe(null);
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

  expect(followingEvents).toEqual(['follow_dids', 'page']);
  expect(followingDids).toEqual([2]);
  for (const duration of durations) expect(typeof duration).toBe('number');

  const publicEvents: string[] = [];
  const publicPool = queuedPool([[row('at://a/review/1', REVIEW_COLLECTION, {}, null)]]);
  await fetchFeedPage(publicPool, {
    kind: 'public',
    viewerDid: null,
    limit: 20,
    observe: (observation) => publicEvents.push(observation.event)
  });
  expect(publicEvents).toEqual(['page']);
});

test('advertises exactly the four documented feeds and no recommendations', () => {
  const kinds: readonly string[] = FEED_KINDS;
  expect(kinds).toEqual(['public', 'following', 'extended', 'dynamic']);
  expect(kinds.includes('recommendations')).toBe(false);
});
