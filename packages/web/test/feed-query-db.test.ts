/**
 * The feed page's two contract guarantees, against real rows.
 *
 * Both were violated in production: `/` shipped a skeleton whose `discover`
 * band repeated one `post`, and Svelte's keyed each threw `each_key_duplicate`
 * on the client, blanking the page after its HTML had arrived.
 *
 * 1. One entry per `post`. `appview_bookhive_lua` is a view over
 *    `edition_identifiers` keyed `(edition_uri, issuer, value)`, so one Bookhive
 *    hive id may name several editions; joining it row-for-row multiplied the
 *    feed row once per edition. The schema permits the fanout even where the
 *    catalog rows do not yet contain one, so the fixture builds it.
 * 2. A repeat is not a "next page". The probe row (`limit + 1`) is counted
 *    after duplicate posts collapse, so a duplicate can never fake a cursor.
 */

import { expect, test, afterAll, beforeAll } from 'vitest';

import pg from 'pg';

import {
  encodeCursor,
  fetchFeedPage,
  BOOK_STATUS_COLLECTION,
  BUZZ_BOOKHIVE_BOOK,
  POPFEED_LIST_ITEM_COLLECTION,
  POPFEED_REVIEW_COLLECTION
} from '../src/lib/server/feeds/query.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = `${process.pid}-${Date.now()}`;
const HIVE_ID = `bk_feedprobe${RUN}`;
const AUTHORITY = 'did:web:biblio.test';
const EDITION_ONE = `at://${AUTHORITY}/community.lexicon.media.book.edition/feedprobe-a-${RUN}`;
const EDITION_TWO = `at://${AUTHORITY}/community.lexicon.media.book.edition/feedprobe-b-${RUN}`;
const PROBE_DID = `did:plc:feedprobe${RUN}`;
const POST_URI = `at://${PROBE_DID}/buzz.bookhive.book/3kfeedprobe`;

// Popfeed names no edition: its records carry ISBN/ASIN identifiers, and the
// page resolves them through `edition_identifiers`. A run-unique ISBN keeps the
// lookup to this fixture alone, so `min(edition_uri)` cannot depend on a
// production edition that happens to share a real ISBN.
const POPFEED_DID = `did:plc:feedprobe${RUN}popfeed`;
const POPFEED_ISBN = `979${RUN.replace(/\D/g, '').slice(-10)}`;
const POPFEED_EDITION = `at://${AUTHORITY}/community.lexicon.media.book.edition/feedprobe-pf-${RUN}`;
const REVIEW_URI = `at://${POPFEED_DID}/${POPFEED_REVIEW_COLLECTION}/3kfeedprobe`;
const LIST_ITEM_URI = `at://${POPFEED_DID}/${POPFEED_LIST_ITEM_COLLECTION}/3kfeedprobe`;
const REVIEW_TIME = new Date(Date.now() - 60_000).toISOString();
const LIST_ITEM_TIME = new Date().toISOString();

// A Bibliograph `bookStatus` is the third personalized branch: it has no
// predicate, so its page is the per-did index descent itself.
const STATUS_DID = `did:plc:feedprobe${RUN}status`;
const STATUS_EDITION = `at://${AUTHORITY}/community.lexicon.media.book.edition/feedprobe-st-${RUN}`;
const STATUS_URI = `at://${STATUS_DID}/net.olamaelcu.livtet.biblio.bookStatus/3kfeedprobe`;
const STATUS_TIME = new Date(Date.now() - 30_000).toISOString();

let pool: pg.Pool | undefined;
let ready = false;

function requiredPool(t: { skip: (message?: string) => void }): pg.Pool | null {
  if (!ready || !pool) {
    t.skip('DATABASE_URL is not reachable; skipping feed integration tests');
    return null;
  }
  return pool;
}

beforeAll(async () => {
  const candidate = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await candidate.query('SELECT 1');
    pool = candidate;
    ready = true;

    for (const uri of [EDITION_ONE, EDITION_TWO]) {
      await pool.query(
        `INSERT INTO books (uri, title, created_at)
         VALUES ($1, $2, now())
         ON CONFLICT (uri) DO NOTHING`,
        [uri, `Feed probe ${RUN}`]
      );
      await pool.query(
        `INSERT INTO edition_identifiers (edition_uri, issuer, value)
         VALUES ($1, 'bookhive.buzz', $2)
         ON CONFLICT (edition_uri, issuer, value) DO NOTHING`,
        [uri, HIVE_ID]
      );
    }

    // The activity row itself: one Bookhive record whose hive id names two
    // editions — the production fanout.
    await pool.query(
      `INSERT INTO happyview.happyview_records (uri, did, collection, rkey, record, cid, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (uri) DO NOTHING`,
      [
        POST_URI,
        PROBE_DID,
        BUZZ_BOOKHIVE_BOOK,
        '3kfeedprobe',
        JSON.stringify({
          $type: BUZZ_BOOKHIVE_BOOK,
          hiveId: HIVE_ID,
          status: 'buzz.bookhive.defs#reading',
          createdAt: new Date().toISOString()
        }),
        `bafyfeedprobe${RUN}`,
        new Date().toISOString()
      ]
    );

    // One edition, reachable only through the Popfeed record's ISBN.
    await pool.query(
      `INSERT INTO books (uri, title, created_at)
       VALUES ($1, $2, now())
       ON CONFLICT (uri) DO NOTHING`,
      [POPFEED_EDITION, `Popfeed probe ${RUN}`]
    );
    await pool.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value)
       VALUES ($1, 'isbn13', $2)
       ON CONFLICT (edition_uri, issuer, value) DO NOTHING`,
      [POPFEED_EDITION, POPFEED_ISBN]
    );

    // A review and a shelf entry. The review carries `createdAt`; the shelf
    // entry carries only `addedAt` — what Popfeed actually writes — and it is
    // the newer of the two.
    await pool.query(
      `INSERT INTO happyview.happyview_records (uri, did, collection, rkey, record, cid, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (uri) DO NOTHING`,
      [
        REVIEW_URI,
        POPFEED_DID,
        POPFEED_REVIEW_COLLECTION,
        '3kfeedprobe',
        JSON.stringify({
          $type: POPFEED_REVIEW_COLLECTION,
          creativeWorkType: 'book',
          rating: 9,
          text: 'Popfeed probe',
          identifiers: { isbn13: POPFEED_ISBN },
          createdAt: REVIEW_TIME
        }),
        `bafyfeedprobe-pf-review${RUN}`,
        REVIEW_TIME
      ]
    );
    await pool.query(
      `INSERT INTO happyview.happyview_records (uri, did, collection, rkey, record, cid, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (uri) DO NOTHING`,
      [
        LIST_ITEM_URI,
        POPFEED_DID,
        POPFEED_LIST_ITEM_COLLECTION,
        '3kfeedprobe',
        JSON.stringify({
          $type: POPFEED_LIST_ITEM_COLLECTION,
          creativeWorkType: 'book',
          listType: 'read_books',
          listUri: `at://${POPFEED_DID}/social.popfeed.feed.list/books`,
          identifiers: { isbn13: POPFEED_ISBN },
          addedAt: LIST_ITEM_TIME
        }),
        `bafyfeedprobe-pf-listitem${RUN}`,
        LIST_ITEM_TIME
      ]
    );
    await pool.query(
      `INSERT INTO happyview.happyview_records (uri, did, collection, rkey, record, cid, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (uri) DO NOTHING`,
      [
        STATUS_URI,
        STATUS_DID,
        BOOK_STATUS_COLLECTION,
        '3kfeedprobe',
        JSON.stringify({
          $type: BOOK_STATUS_COLLECTION,
          book: { uri: STATUS_EDITION, cid: 'bafyfeedprobe' },
          status: 'reading',
          createdAt: STATUS_TIME
        }),
        `bafyfeedprobe-status${RUN}`,
        STATUS_TIME
      ]
    );
  } catch {
    await candidate.end().catch(() => undefined);
    pool = undefined;
    ready = false;
  }
});

afterAll(async () => {
  if (pool) {
    await pool
      .query('DELETE FROM happyview.happyview_records WHERE uri = ANY($1::text[])', [
        [POST_URI, REVIEW_URI, LIST_ITEM_URI, STATUS_URI]
      ])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM edition_identifiers WHERE value = ANY($1::text[])', [
        [HIVE_ID, POPFEED_ISBN]
      ])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM books WHERE uri = ANY($1::text[])', [
        [EDITION_ONE, EDITION_TWO, POPFEED_EDITION]
      ])
      .catch(() => undefined);
  }
  await pool?.end().catch(() => undefined);
});

test('a hive id that names two editions still emits one post', async (t) => {
  const live = requiredPool(t);
  if (!live) return;

  // `dynamic` scoped to the probe account: the page holds this fixture and
  // nothing else, so "one post" is about the join, not about the catalog's
  // size.
  const page = await fetchFeedPage(live, { kind: 'dynamic', viewerDid: PROBE_DID, limit: 20 });

  const posts = page.feed.map((item) => item.post).filter((post) => post === POST_URI);
  expect(posts.length, `post emitted ${posts.length} times`).toBe(1);

  const entry = page.feed.find((item) => item.post === POST_URI);
  expect(entry?.reason?.startsWith('bookhive:reading'), `reason was ${entry?.reason}`).toBeTruthy();
});

test('the duplicated editions cannot fake a next page', async (t) => {
  const live = requiredPool(t);
  if (!live) return;

  // `limit: 1` makes the probe row matter: one record joining twice used to
  // return two rows and read as "there is another page", sending the client
  // after a page that does not exist.
  const first = await fetchFeedPage(live, { kind: 'dynamic', viewerDid: PROBE_DID, limit: 1 });

  expect(first.feed.map((item) => item.post)).toEqual([POST_URI]);
  expect(first.cursor).toBe(undefined);
});

test('Popfeed records resolve their ISBN to an edition and page by addedAt', async (t) => {
  const live = requiredPool(t);
  if (!live) return;

  const page = await fetchFeedPage(live, { kind: 'dynamic', viewerDid: POPFEED_DID, limit: 20 });

  // The shelf entry is newer by `addedAt` alone, so it sorts above the review:
  // an `addedAt`-only row is not a NULL-tail row.
  expect(page.feed).toEqual([
    { post: LIST_ITEM_URI, reason: `popfeed:read|${POPFEED_EDITION}` },
    { post: REVIEW_URI, reason: `popfeed:review|${POPFEED_EDITION}` }
  ]);

  // One row out, one cursor: the keyset carries the `addedAt` time, so the
  // continuation pages from the same expression the order used.
  const first = await fetchFeedPage(live, { kind: 'dynamic', viewerDid: POPFEED_DID, limit: 1 });

  expect(first.feed.map((item) => item.post)).toEqual([LIST_ITEM_URI]);
  expect(first.cursor).toBe(encodeCursor({ c: LIST_ITEM_TIME, u: LIST_ITEM_URI }));
});

test('a bookStatus pages through the per-did branch and names its book', async (t) => {
  const live = requiredPool(t);
  if (!live) return;

  const page = await fetchFeedPage(live, { kind: 'dynamic', viewerDid: STATUS_DID, limit: 20 });

  expect(page.feed).toEqual([{ post: STATUS_URI, reason: STATUS_EDITION }]);
});
