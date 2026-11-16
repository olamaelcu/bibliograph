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

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { fetchFeedPage, BUZZ_BOOKHIVE_BOOK } from '../src/lib/server/feeds/query.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = `${process.pid}-${Date.now()}`;
const HIVE_ID = `bk_feedprobe${RUN}`;
const AUTHORITY = 'did:web:biblio.test';
const EDITION_ONE = `at://${AUTHORITY}/community.lexicon.media.book.edition/feedprobe-a-${RUN}`;
const EDITION_TWO = `at://${AUTHORITY}/community.lexicon.media.book.edition/feedprobe-b-${RUN}`;
const PROBE_DID = `did:plc:feedprobe${RUN}`;
const POST_URI = `at://${PROBE_DID}/buzz.bookhive.book/3kfeedprobe`;

let pool: pg.Pool | undefined;
let ready = false;

function requiredPool(t: { skip: (message?: string) => void }): pg.Pool | null {
  if (!ready || !pool) {
    t.skip('DATABASE_URL is not reachable; skipping feed integration tests');
    return null;
  }
  return pool;
}

before(async () => {
  const candidate = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await candidate.query('SELECT 1');
    pool = candidate;
    ready = true;

    for (const uri of [EDITION_ONE, EDITION_TWO]) {
      await pool.query(
        `INSERT INTO editions (uri, title, created_at)
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
  } catch {
    await candidate.end().catch(() => undefined);
    pool = undefined;
    ready = false;
  }
});

after(async () => {
  if (pool) {
    await pool
      .query('DELETE FROM happyview.happyview_records WHERE uri = $1', [POST_URI])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM edition_identifiers WHERE value = $1', [HIVE_ID])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM editions WHERE uri = ANY($1::text[])', [[EDITION_ONE, EDITION_TWO]])
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
  assert.equal(posts.length, 1, `post emitted ${posts.length} times`);

  const entry = page.feed.find((item) => item.post === POST_URI);
  assert.ok(entry?.reason?.startsWith('bookhive:reading'), `reason was ${entry?.reason}`);
});

test('the duplicated editions cannot fake a next page', async (t) => {
  const live = requiredPool(t);
  if (!live) return;

  // `limit: 1` makes the probe row matter: one record joining twice used to
  // return two rows and read as "there is another page", sending the client
  // after a page that does not exist.
  const first = await fetchFeedPage(live, { kind: 'dynamic', viewerDid: PROBE_DID, limit: 1 });

  assert.deepEqual(first.feed.map((item) => item.post), [POST_URI]);
  assert.equal(first.cursor, undefined);
});
