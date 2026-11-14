import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

import { runReportFrom } from '../src/lib/server/admin/reports.ts';
import type { ReportResponse } from '../src/lib/admin/types.ts';

/**
 * Every SQL report against a private scratch schema.
 *
 * `0001` and `0004` are applied into a schema created for this process, the
 * client's search_path points at it, and the reports (which use unqualified
 * table names) read only the seeded rows. The schema is dropped afterwards.
 * When DATABASE_URL is unreachable the tests skip, like the other DB tests.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const AUTHORITY = `did:plc:reports${process.pid}`;
const EDITION_COLLECTION = 'community.lexicon.media.book.edition';
const PREFIX = `at://${AUTHORITY}/${EDITION_COLLECTION}/`;

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schema = '';
let ready = false;

const uri = (rkey: string): string => `${PREFIX}${rkey}`;

/** Fresh database bootstrap, then the entity-records migration. */
const SCHEMA_FILES = [
  '0001-catalog-schema.sql',
  '0004-entity-records.sql',
  '0007-edition-identifier-info.sql',
  '0008-edition-identifier-publishers.sql'
];

async function applySchema(db: pg.PoolClient): Promise<void> {
  for (const file of SCHEMA_FILES) {
    const sql = readFileSync(new URL(`../../worker/sql/${file}`, import.meta.url), 'utf8');
    await db.query(sql);
  }
}

async function addEdition(
  db: pg.PoolClient,
  edition: {
    rkey: string;
    title: string;
    cover: string | null;
    indexedAt: string;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO editions (
       uri, rkey, title, cover_url, created_at, indexed_at
     ) VALUES ($1, $2, $3, $4, $5, $5)`,
    [uri(edition.rkey), edition.rkey, edition.title, edition.cover, edition.indexedAt]
  );
}

async function addEntity(
  db: pg.PoolClient,
  table: 'contributors' | 'publishers',
  name: string,
  identifiers: string,
  atUri: string | null
): Promise<number> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO ${table} (name, identifiers, at_uri) VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [name, identifiers, atUri]
  );
  return Number(result.rows[0]?.id);
}

async function addIdentifier(
  db: pg.PoolClient,
  rkey: string,
  issuer: string,
  value: string,
  claim: {
    format?: string | null;
    language?: string | null;
    publishedDate?: string | null;
    pages?: number | null;
    description?: string | null;
  } = {}
): Promise<void> {
  await db.query(
    'INSERT INTO edition_identifiers (edition_uri, issuer, value) VALUES ($1, $2, $3)',
    [uri(rkey), issuer, value]
  );
  // `edition_identifier_info` holds the shape claims (0007); the reports read
  // only these rows, never the edition.
  if (Object.keys(claim).length === 0) return;
  await db.query(
    `INSERT INTO edition_identifier_info
       (edition_uri, issuer, value, format, language, published_date, pages, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      uri(rkey),
      issuer,
      value,
      claim.format ?? null,
      claim.language ?? null,
      claim.publishedDate ?? null,
      claim.pages ?? null,
      claim.description ?? null
    ]
  );
}

async function seed(db: pg.PoolClient): Promise<void> {
  // e1: every completeness field missing, one CID, a contributor and publisher
  // without identifiers, and a duplicate identifier pair shared with e2.
  await addEdition(db, {
    rkey: 'r01',
    title: 'Alpha',
    cover: null,
    indexedAt: '2020-01-03T00:00:00.000Z'
  });
  // e2: empty-string values, a shared ISBN, a second ISBN and a goodreads id.
  await addEdition(db, {
    rkey: 'r02',
    title: 'Beta',
    cover: '',
    indexedAt: '2020-01-02T00:00:00.000Z'
  });
  // e3: whitespace-only cover, no identifiers, no links, no CID.
  await addEdition(db, {
    rkey: 'r03',
    title: 'Gamma',
    cover: '   ',
    indexedAt: '2020-01-01T00:00:00.000Z'
  });
  // e4: complete edition whose only identifier contains LIKE metacharacters.
  await addEdition(db, {
    rkey: 'r04',
    title: 'Delta',
    cover: 'https://example.org/delta.jpg',
    indexedAt: '2019-12-31T00:00:00.000Z'
  });

  await addIdentifier(db, 'r01', 'isbn13', '9780000000001');
  await addIdentifier(db, 'r01', 'isbn13', '9780000000002');
  // A whitespace-only claim is still a missing description/language/date; a
  // recorded page count of 0 counts as present, so it leaves the pages report.
  await addIdentifier(db, 'r02', 'isbn13', '9780000000001', {
    description: '   ',
    language: ' ',
    publishedDate: '',
    pages: 0
  });
  await addIdentifier(db, 'r02', 'isbn13', '9780000000003');
  await addIdentifier(db, 'r02', 'goodreads', 'abc');
  await addIdentifier(db, 'r04', 'test', 'a%b_c', {
    format: 'hardcover',
    language: 'en',
    publishedDate: '2024-01-01',
    pages: 120,
    description: 'A complete edition.'
  });

  const emptyContributor = await addEntity(
    db,
    'contributors',
    'Empty Identifiers',
    '[]',
    null
  );
  const nullContributor = await addEntity(db, 'contributors', 'Null Identifiers', 'null', null);
  const fullContributor = await addEntity(
    db,
    'contributors',
    'Has Identifiers',
    '[{"issuer":"orcid","value":"0000-0002-1825-0097"}]',
    `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/c01`
  );
  const emptyPublisher = await addEntity(db, 'publishers', 'Empty Press', '[]', null);
  const fullPublisher = await addEntity(
    db,
    'publishers',
    'Full Press',
    '[{"issuer":"isni","value":"1"}]',
    `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.publisher/p01`
  );

  // r04's only identifier gets its own publisher, so a name filter can select it
  // uniquely; the report's publisher column comes from this link, never a claim.
  const reportPublisher = await addEntity(
    db,
    'publishers',
    'Solstice Press',
    '[{"issuer":"isni","value":"2"}]',
    null
  );
  await db.query(
    `INSERT INTO edition_identifier_publishers
       (edition_uri, issuer, value, publisher_id, position)
     VALUES ($1, 'test', 'a%b_c', $2, 1)`,
    [uri('r04'), reportPublisher]
  );

  await db.query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
     VALUES ($1, $2, 1, 'A01')`,
    [uri('r01'), emptyContributor]
  );
  await db.query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
     VALUES ($1, $2, 1, 'A01'), ($1, $3, 2, 'B01')`,
    [uri('r02'), fullContributor, nullContributor]
  );
  await db.query(
    `INSERT INTO edition_identifier_publishers
       (edition_uri, issuer, value, publisher_id, position)
     VALUES ($1, 'isbn13', '9780000000001', $2, 1)`,
    [uri('r01'), emptyPublisher]
  );
  await db.query(
    `INSERT INTO edition_identifier_publishers
       (edition_uri, issuer, value, publisher_id, position)
     VALUES ($1, 'isbn13', '9780000000001', $2, 1)`,
    [uri('r02'), fullPublisher]
  );

  await db.query('INSERT INTO pds_cids (uri, cid) VALUES ($1, $2)', [uri('r01'), 'bafycid1']);

  // The triggers queued all four editions. Park e2 and make e3 overdue; e1 and
  // e4 remain healthy (next_at defaults to now()).
  await db.query(
    "UPDATE pds_outbox SET attempts = 10, last_error = 'boom' WHERE uri = $1",
    [uri('r02')]
  );
  await db.query(
    "UPDATE pds_outbox SET next_at = now() - interval '2 hours' WHERE uri = $1",
    [uri('r03')]
  );
}

async function report(
  id: string,
  query = ''
): Promise<ReportResponse> {
  assert.ok(client, 'scratch client');
  return runReportFrom(client, id, new URLSearchParams(query));
}

function uris(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) => String(row.uri));
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await pool.query('SELECT 1');
  } catch {
    ready = false;
    return;
  }
  ready = true;
  schema = `admin_reports_${process.pid}_${Date.now()}`;
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await applySchema(client);
  await seed(client);
});

after(async () => {
  if (client) {
    client.release();
    client = undefined;
  }
  if (pool && schema !== '') {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  }
  if (pool) await pool.end();
});

function requireDatabase(t: { skip: (message?: string) => void }): void {
  if (!ready || !client) t.skip('DATABASE_URL is not reachable; skipping report integration tests');
}

test('editions missing a cover include NULL, empty and whitespace-only values', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  const result = await report('editions-missing-cover');
  assert.equal(result.total, 3);
  assert.deepEqual(uris(result.rows), [uri('r01'), uri('r02'), uri('r03')]);
  assert.equal(result.rows[0]?.title, 'Alpha');
  assert.equal(result.rows[0]?.rkey, 'r01');
  assert.equal(result.rows[0]?.uri, `at://${AUTHORITY}/${EDITION_COLLECTION}/r01`);
  assert.equal(typeof result.rows[0]?.indexed_at, 'string');
});

test('completeness reports cover descriptions, languages, pages and dates', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  assert.deepEqual(uris((await report('editions-missing-description')).rows).sort(), [
    uri('r01'),
    uri('r02'),
    uri('r03')
  ]);
  assert.deepEqual(uris((await report('editions-missing-language')).rows).sort(), [
    uri('r01'),
    uri('r02'),
    uri('r03')
  ]);
  assert.deepEqual(uris((await report('editions-missing-pages')).rows).sort(), [
    uri('r01'),
    uri('r03')
  ]);
  assert.deepEqual(uris((await report('editions-missing-published-date')).rows).sort(), [
    uri('r01'),
    uri('r02'),
    uri('r03')
  ]);
});

test('identifier report enumerates identifiers, claims and publisher links', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  const all = await report('edition-identifier-info');
  // One row per identifier, including ones without a claim row.
  assert.equal(all.total, 6);
  assert.deepEqual(uris(all.rows).sort(), [
    uri('r01'),
    uri('r01'),
    uri('r02'),
    uri('r02'),
    uri('r02'),
    uri('r04')
  ]);

  // Format compares case-insensitively.
  const hardcover = await report('edition-identifier-info', 'format=HARDCOVER');
  assert.equal(hardcover.total, 1);
  assert.equal(hardcover.rows[0]?.uri, uri('r04'));
  assert.equal(hardcover.rows[0]?.issuer, 'test');
  assert.equal(hardcover.rows[0]?.value, 'a%b_c');
  assert.equal(hardcover.rows[0]?.publisher, 'Solstice Press');
  assert.equal(hardcover.params.format, 'HARDCOVER');

  // The publisher filter matches the linked entity name.
  const byPublisher = await report('edition-identifier-info', 'publisher=solstice');
  assert.deepEqual(uris(byPublisher.rows), [uri('r04')]);
  assert.equal(byPublisher.params.publisher, 'solstice');

  // Issuer is exact, so only ISBN rows come back (four across r01/r02).
  const isbn = await report('edition-identifier-info', 'issuer=isbn13');
  assert.equal(isbn.total, 4);

  // The value filter is an escaped substring, not a pattern.
  // `%` and `_` are literals: "%b_" matches the seeded value literally...
  assert.equal((await report('edition-identifier-info', 'value=%25b_')).total, 1);
  // ...while a wildcard-shaped "%b%" matches nothing, because it is escaped.
  assert.equal((await report('edition-identifier-info', 'value=%25b%25')).total, 0);
  assert.equal((await report('edition-identifier-info', 'value=_')).total, 1);

  await assert.rejects(report('edition-identifier-info', 'nope=1'), (error: unknown) => {
    const typed = error as { code?: string; status?: number };
    return typed.code === 'UnsupportedParameter' && typed.status === 400;
  });
});

test('editions without contributors or publishers', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  assert.deepEqual(uris((await report('editions-without-contributors')).rows).sort(), [
    uri('r03'),
    uri('r04')
  ]);
  assert.deepEqual(uris((await report('editions-without-publishers')).rows).sort(), [
    uri('r03')
  ]);
});

test('editions without a published CID use a left join', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  const result = await report('editions-without-cid');
  assert.equal(result.total, 3);
  assert.deepEqual(uris(result.rows).sort(), [uri('r02'), uri('r03'), uri('r04')]);
});

test('identifier count supports eq/gte/lte and m=0', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  const zero = await report('edition-identifier-count', 'comparison=eq&m=0');
  assert.deepEqual(uris(zero.rows), [uri('r03')]);
  assert.equal(zero.rows[0]?.matching_identifiers, 0);

  const three = await report('edition-identifier-count', 'comparison=eq&m=3');
  assert.deepEqual(uris(three.rows), [uri('r02')]);
  assert.equal(three.rows[0]?.matching_identifiers, 3);

  const atLeastTwo = await report('edition-identifier-count', 'comparison=gte&m=2');
  assert.deepEqual(uris(atLeastTwo.rows), [uri('r02'), uri('r01')]);
  assert.deepEqual(
    atLeastTwo.rows.map((row) => row.matching_identifiers),
    [3, 2]
  );

  const atMostOne = await report('edition-identifier-count', 'comparison=lte&m=1');
  assert.deepEqual(uris(atMostOne.rows), [uri('r04'), uri('r03')]);
});

test('identifier count filters by issuer and by an escaped value substring', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  const issuers = await report(
    'edition-identifier-count',
    'issuer=goodreads&comparison=gte&m=1'
  );
  assert.deepEqual(uris(issuers.rows), [uri('r02')]);
  assert.equal(issuers.rows[0]?.matching_identifiers, 1);

  const isbn = await report(
    'edition-identifier-count',
    'issuer=isbn13&value=978&comparison=gte&m=2'
  );
  assert.deepEqual(uris(isbn.rows), [uri('r01'), uri('r02')]);

  // A literal '%' must match e4's a%b_c, not act as "match anything".
  const percent = await report(
    'edition-identifier-count',
    'value=%25&comparison=eq&m=1'
  );
  assert.deepEqual(uris(isbn.rows), [uri('r01'), uri('r02')]);
  assert.deepEqual(uris(percent.rows), [uri('r04')]);
  assert.equal(percent.rows[0]?.matching_identifiers, 1);

  const underscore = await report('edition-identifier-count', 'value=_&comparison=eq&m=1');
  assert.deepEqual(uris(underscore.rows), [uri('r04')]);

  // A wildcard-style pattern that is escaped matches nothing.
  const literalWildcard = await report(
    'edition-identifier-count',
    'value=%25%25&comparison=eq&m=1'
  );
  assert.equal(literalWildcard.total, 0);
});

test('report pagination is stable and independent of the full count', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  const first = await report('edition-identifier-count', 'comparison=gte&m=0&limit=2&offset=0');
  const second = await report('edition-identifier-count', 'comparison=gte&m=0&limit=2&offset=2');
  assert.equal(first.total, 4);
  assert.equal(second.total, 4);
  assert.deepEqual(uris(first.rows), [uri('r02'), uri('r01')]);
  assert.deepEqual(uris(second.rows), [uri('r04'), uri('r03')]);
  assert.equal(first.limit, 2);
  assert.equal(second.offset, 2);
  assert.equal(first.params.comparison, 'gte');
  assert.equal(first.params.m, 0);
});

test('contributors with no identifiers include empty arrays, JSON null and unminted rows', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  const result = await report('contributors-missing-identifiers');
  assert.equal(result.total, 2);
  const rows = [...result.rows].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  assert.deepEqual(
    rows.map((row) => row.name),
    ['Empty Identifiers', 'Null Identifiers']
  );
  for (const row of rows) {
    assert.equal(row.identifier_status, 'none');
    assert.equal(row.identifier_count, 0);
    assert.equal(row.at_uri, null);
  }

  const publishers = await report('publishers-missing-identifiers');
  assert.equal(publishers.total, 1);
  assert.equal(publishers.rows[0]?.name, 'Empty Press');
  assert.equal(publishers.rows[0]?.at_uri, null);
});

test('duplicate identifier pairs list every edition by canonical AT URI', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  const result = await report('duplicate-identifier-pairs');
  assert.equal(result.total, 1);
  const row = result.rows[0];
  assert.ok(row);
  assert.equal(row.issuer, 'isbn13');
  assert.equal(row.value, '9780000000001');
  assert.equal(row.edition_count, 2);
  const editions = row.editions as Array<{ uri: string; rkey: string; title: string }>;
  assert.deepEqual(editions, [
    { uri: uri('r01'), rkey: 'r01', title: 'Alpha' },
    { uri: uri('r02'), rkey: 'r02', title: 'Beta' }
  ]);
});

test('outbox reports list pending and stale edition records', async (t) => {
  requireDatabase(t);
  if (!ready) return;

  const pending = await report('outbox-pending-editions');
  assert.equal(pending.total, 4);
  for (const row of pending.rows) {
    assert.equal(row.op, 'create');
    assert.equal(row.collection, EDITION_COLLECTION);
    assert.match(String(row.uri), /^at:\/\//);
    assert.equal(typeof row.next_at, 'string');
    assert.equal(Number.isNaN(new Date(String(row.next_at)).getTime()), false);
  }

  const stale = await report('outbox-stale-editions');
  assert.equal(stale.total, 2);
  assert.deepEqual(uris(stale.rows), [uri('r02'), uri('r03')]);
  assert.equal(stale.rows[0]?.stale_reason, 'parked');
  assert.equal(stale.rows[0]?.attempts, 10);
  assert.equal(stale.rows[0]?.last_error, 'boom');
  assert.equal(stale.rows[1]?.stale_reason, 'overdue');
});
