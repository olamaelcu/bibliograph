/**
 * `searchEditions` ordering and language filtering against the development
 * catalog.
 *
 * `sort`/`order`/`language` are local extensions over the lexicon's
 * provider-defined ranking, so they are exercised against real rows: the shape
 * claims decide both the published year and the language a filter sees, and
 * `0011-language-normalization.sql` keeps those claims canonical on write.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { listEditionsByContributor } from '../src/lib/server/catalog/entities.ts';
import { searchEditions } from '../src/lib/server/catalog/editions.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = `${process.pid}-${Date.now()}`;
const AUTHORITY = `did:plc:searchsort${process.pid}`;
const EDITION_COLLECTION = 'community.lexicon.media.book.edition';
const CONTRIBUTOR_URI = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/author`;
const TOKEN = `SortProbe${process.pid}`;

let pool: pg.Pool | undefined;
let ready = false;

function requiredPool(t: { skip: (message?: string) => void }): pg.Pool | null {
  if (!ready || !pool) {
    t.skip('DATABASE_URL is not reachable; skipping catalog integration tests');
    return null;
  }
  return pool;
}

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`at://${AUTHORITY}/%`]);
}

type Fixture = {
  title: string;
  language: string | null;
  publishedDate: string | null;
  identifier: string;
};

/** One edition with a single isbn13 identifier carrying the given claims. */
async function seedEdition(fixture: Fixture): Promise<void> {
  const db = pool as pg.Pool;
  const rkey = fixture.identifier;
  const uri = `at://${AUTHORITY}/${EDITION_COLLECTION}/${rkey}`;
  await db.query(
    `INSERT INTO editions (uri, rkey, title, created_at, indexed_at)
     VALUES ($1, $2, $3, now(), now())`,
    [uri, rkey, fixture.title]
  );
  await db.query(
    `INSERT INTO edition_identifiers (edition_uri, issuer, value)
     VALUES ($1, 'isbn13', $2)`,
    [uri, fixture.identifier]
  );
  await db.query(
    `INSERT INTO edition_identifier_info
       (edition_uri, issuer, value, language, published_date)
     VALUES ($1, 'isbn13', $2, $3, $4)`,
    [uri, fixture.identifier, fixture.language, fixture.publishedDate]
  );
}

/** Titles of the fixture editions a query returned, in result order. */
async function titles(input: Parameters<typeof searchEditions>[0]): Promise<string[]> {
  const results = await searchEditions(input, pool as pg.Pool);
  return results.items.map((item) => item.title);
}

const base = { identifiers: [], offset: 0, limit: 25, title: TOKEN };

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await pool.query('SELECT 1');
    ready = true;
    await cleanup();
    await seedEdition({
      title: `${TOKEN} Beta`,
      language: 'en',
      publishedDate: '2020',
      identifier: '9780000000701'
    });
    await seedEdition({
      title: `${TOKEN} alpha`,
      language: 'en-US',
      publishedDate: '1999-05',
      identifier: '9780000000702'
    });
    await seedEdition({
      title: `${TOKEN} Gamma`,
      language: 'es',
      publishedDate: null,
      identifier: '9780000000703'
    });
    await seedEdition({
      title: `${TOKEN} Delta`,
      language: 'es',
      publishedDate: '2005-02-01',
      identifier: '9780000000704'
    });
  } catch (error) {
    ready = false;
    console.error('[test] search sort fixture failed', error);
  }
});
// Every fixture is credited to one contributor, so the same rows drive the
// search and the contributor listing. Idempotent, so a helper can call it.
async function creditFixtures(): Promise<void> {
  const db = pool as pg.Pool;
  const contributor = await db.query(
    `INSERT INTO contributors (name, identifiers, at_uri)
     VALUES ($1, '[]'::jsonb, $2)
     ON CONFLICT (lower(name), identifiers) DO UPDATE SET at_uri = EXCLUDED.at_uri
     RETURNING id`,
    [`${TOKEN} Author`, CONTRIBUTOR_URI]
  );
  await db.query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
     SELECT e.uri, $1, 1, 'A01' FROM editions e WHERE e.uri LIKE $2
     ON CONFLICT DO NOTHING`,
    [Number(contributor.rows[0]?.id), `at://${AUTHORITY}/%`]
  );
}

after(async () => {
  if (pool) {
    await cleanup().catch(() => {});
    await pool.end();
  }
});

test('sorts by title, case-insensitively, with uri as the stable tie-break', async (t) => {
  if (!requiredPool(t)) return;

  assert.deepEqual(await titles({ ...base, sort: 'title' }), [
    `${TOKEN} alpha`,
    `${TOKEN} Beta`,
    `${TOKEN} Delta`,
    `${TOKEN} Gamma`
  ]);
  assert.deepEqual(await titles({ ...base, sort: 'title', order: 'desc' }), [
    `${TOKEN} Gamma`,
    `${TOKEN} Delta`,
    `${TOKEN} Beta`,
    `${TOKEN} alpha`
  ]);
});

test('sorts by published year from the shape claim, unknown years last', async (t) => {
  if (!requiredPool(t)) return;

  assert.deepEqual(await titles({ ...base, sort: 'publishedYear' }), [
    `${TOKEN} alpha`,
    `${TOKEN} Delta`,
    `${TOKEN} Beta`,
    `${TOKEN} Gamma`
  ]);
  assert.deepEqual(await titles({ ...base, sort: 'publishedYear', order: 'desc' }), [
    `${TOKEN} Beta`,
    `${TOKEN} Delta`,
    `${TOKEN} alpha`,
    `${TOKEN} Gamma`
  ]);
});

test('keeps the relevance order when no sort is asked for', async (t) => {
  if (!requiredPool(t)) return;

  // Every fixture is a title match, so relevance ties and `e.uri` decides; all
  // four are present and the ordering repeats.
  const first = await titles(base);
  const second = await titles(base);
  assert.equal(first.length, 4);
  assert.deepEqual(first, second, 'the default order is stable across calls');
});

test('filters by language on the primary subtag and needs no other hint', async (t) => {
  if (!requiredPool(t)) return;

  // `en` matches both the `en` and the `en-US` claim.
  assert.deepEqual((await titles({ ...base, language: 'en' })).sort(), [
    `${TOKEN} Beta`,
    `${TOKEN} alpha`
  ]);
  // A second language, case-insensitively.
  assert.deepEqual((await titles({ ...base, language: 'ES' })).sort(), [
    `${TOKEN} Delta`,
    `${TOKEN} Gamma`
  ]);
  // The filter is ANDed with the hints, not ORed.
  assert.deepEqual(await titles({ ...base, title: `${TOKEN} Gamma`, language: 'es' }), [
    `${TOKEN} Gamma`
  ]);
  assert.deepEqual(await titles({ ...base, title: `${TOKEN} Gamma`, language: 'en' }), []);
  // With no hint at all, a language is still a valid browse — and it filters
  // rather than needing a term. This used to assert that a fixture landed on
  // page one, which only held because the page was ordered by `indexed_at DESC`
  // and the fixture was the newest ingest. The listing no longer sorts by
  // recency (page one is uri order, the primary key), so the assertion is the
  // filter's effect: rows come back, and a language nothing claims returns none.
  const browse = await titles({ identifiers: [], offset: 0, limit: 25, language: 'es' });
  assert.ok(browse.length > 0, 'a language-only query returns catalog rows');
  assert.deepEqual(
    await titles({ identifiers: [], offset: 0, limit: 25, language: 'zz' }),
    [],
    'and the language still filters it'
  );
});

/** Titles of the contributor listing for one set of params. */
async function creditedTitles(input: {
  language?: string;
  sort?: 'relevance' | 'title' | 'publishedYear';
  order?: 'asc' | 'desc';
}): Promise<string[]> {
  await creditFixtures();
  const page = await listEditionsByContributor(pool as pg.Pool, {
    contributor: CONTRIBUTOR_URI,
    offset: 0,
    limit: 25,
    ...input
  });
  return (page?.items ?? []).map((item) => item.edition.title);
}

test('the contributor listing sorts exactly like a search', async (t) => {
  if (!requiredPool(t)) return;

  // Same fixtures, same expectations: the ordering is one shared clause.
  for (const params of [
    { sort: 'title' as const },
    { sort: 'title' as const, order: 'desc' as const },
    { sort: 'publishedYear' as const },
    { sort: 'publishedYear' as const, order: 'desc' as const }
  ]) {
    assert.deepEqual(
      await creditedTitles(params),
      await titles({ ...base, ...params }),
      `contributor listing matches searchEditions for ${JSON.stringify(params)}`
    );
  }

  // `relevance` is the listing's own order (newest first), not the search's.
  const newestFirst = await creditedTitles({ sort: 'relevance' });
  assert.equal(newestFirst.length, 4);
  assert.deepEqual(await creditedTitles({}), newestFirst);
});

test('the contributor listing filters by language and counts what it returns', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  await creditFixtures();

  const english = await listEditionsByContributor(db, {
    contributor: CONTRIBUTOR_URI,
    language: 'en',
    offset: 0,
    limit: 25
  });
  assert.deepEqual(
    (english?.items ?? []).map((item) => item.edition.title).sort(),
    [`${TOKEN} Beta`, `${TOKEN} alpha`]
  );
  // The total counts what the filter returned, not every credited edition.
  assert.equal(english?.total, 2);
  assert.equal(english?.cursor, undefined);

  const spanish = await listEditionsByContributor(db, {
    contributor: CONTRIBUTOR_URI,
    language: 'ES',
    offset: 0,
    limit: 25
  });
  assert.deepEqual(
    (spanish?.items ?? []).map((item) => item.edition.title).sort(),
    [`${TOKEN} Delta`, `${TOKEN} Gamma`]
  );
  assert.equal(spanish?.total, 2);

  const all = await listEditionsByContributor(db, {
    contributor: CONTRIBUTOR_URI,
    offset: 0,
    limit: 25
  });
  assert.equal(all?.items.length, 4);
  assert.equal(all?.total, 4);
});
