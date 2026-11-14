/**
 * Fresh-database verification for packages/worker/sql/0001-catalog-schema.sql.
 *
 * These tests need an *empty* scratch database and are skipped by default so
 * `node --test test/*.test.js` stays safe against the normal development
 * database. `mise run catalog-schema-check` creates and drops that database:
 *
 *   CATALOG_SCHEMA_TEST_DATABASE_URL=postgres://…/scratch node --test test/catalog-schema.test.js
 *
 * The schema is applied through the same SQL file the deployment uses, then the
 * real worker ingest/claim/complete code is exercised against it.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';

import { createIngest } from '../lib/ingest.js';
import { claimBatch, completeEntry } from '../lib/publish.js';
import { prepareEntityRecords } from '../lib/prepare-entities.js';

const DATABASE_URL = process.env.CATALOG_SCHEMA_TEST_DATABASE_URL;
const SKIP = DATABASE_URL
  ? false
  : 'set CATALOG_SCHEMA_TEST_DATABASE_URL to an empty scratch database';

const SCHEMA_DIR_URL = new URL('../sql/', import.meta.url);
const AUTHORITY = 'did:plc:catalogschemacheck';
const COLLECTION = 'community.lexicon.media.book.edition';
const CONTRIBUTOR = 'Catalog Schema Probe Author';
const CONTRIBUTOR_RENAMED = 'Catalog Schema Probe Author Renamed';
const PUBLISHER = 'Catalog Schema Probe Press';
const PUBLISHER_RENAMED = 'Catalog Schema Probe Press Renamed';
const ISBN = '9780306406157';
const OUTBOX_COLLECTION = 'community.lexicon.media.book.edition';

const candidate = {
  identifiers: [
    { issuer: 'isbn13', value: ISBN },
    { issuer: 'googlebooks', value: 'schema-probe-volume' }
  ],
  title: 'Schema Bootstrap Probe',
  language: 'en',
  publishedDate: '2026-11-11',
  format: 'paperback',
  pages: 321,
  durationSeconds: 11_400,
  chapters: 12,
  series: { name: 'Bootstrap', position: '1' },
  bookEdition: 'first',
  description: 'A probe edition.',
  coverUrl: 'https://example.org/cover.jpg',
  contributors: [
    {
      name: CONTRIBUTOR,
      role: 'author',
      description: 'A probe author bio.',
      identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
      ref: 'at://did:plc:probecontributor/community.lexicon.media.book.contributor/1'
    }
  ],
  publisher: {
    name: PUBLISHER,
    identifiers: [{ issuer: 'isni', value: '0000000121032683' }]
  }
};

let pool;
let editionUri;
let editionRkey;

async function applySchema() {
  const files = (await fs.readdir(SCHEMA_DIR_URL))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await pool.query(await fs.readFile(new URL(file, SCHEMA_DIR_URL), 'utf8'));
  }
}

async function cleanup() {
  if (!pool) return;
  const prefix = `at://${AUTHORITY}/%`;
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM contributors WHERE name LIKE $1', ['Catalog Schema Probe%']);
  await pool.query('DELETE FROM publishers WHERE name LIKE $1', ['Catalog Schema Probe%']);
}

before(async () => {
  if (!DATABASE_URL) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  await applySchema();
  await cleanup();
});

after(async () => {
  if (!pool) return;
  await cleanup();
  await pool.end();
});

test('applies idempotently and creates the catalog tables, functions, triggers and views', { skip: SKIP }, async () => {
  // Second application must be a no-op, not an error.
  await applySchema();

  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name = ANY($1)
      ORDER BY table_name`,
    [[
      'contributors',
      'edition_contributors',
      'edition_genre_fetches',
      'edition_genres',
      'edition_identifier_info',
      'edition_identifier_publishers',
      'edition_identifiers',
      'editions',
      'genres',
      'google_books_cache',
      'isbndb_cache',
      'pds_cids',
      'pds_outbox',
      'provider_daily_usage',
      'publishers'
    ]]
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    [
      'contributors',
      'edition_contributors',
      'edition_genre_fetches',
      'edition_genres',
      'edition_identifier_info',
      'edition_identifier_publishers',
      'edition_identifiers',
      'editions',
      'genres',
      'google_books_cache',
      'isbndb_cache',
      'pds_cids',
      'pds_outbox',
      'provider_daily_usage',
      'publishers'
    ]
  );

  const views = await pool.query(
    `SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name`,
    [['appview_book', 'appview_book_lua', 'edition_identifier_shape', 'edition_publishers_shape']]
  );
  assert.deepEqual(
    views.rows.map((row) => row.table_name),
    ['appview_book', 'appview_book_lua', 'edition_identifier_shape', 'edition_publishers_shape']
  );

  const functions = await pool.query(
    `SELECT proname FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = ANY($1)
      ORDER BY proname`,
    [[
      'catalog_enqueue_genre_fetch',
      'editions_next_tid',
      'editions_tid_encode',
      'pds_enqueue_contributor_editions',
      'pds_enqueue_edition',
      'pds_enqueue_edition_child',
      'pds_enqueue_entity',
      'pds_enqueue_publisher_editions'
    ]]
  );
  assert.equal(functions.rows.length, 8);

  const triggers = await pool.query(
    `SELECT tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
      ORDER BY tgname`
  );
  assert.deepEqual(
    triggers.rows.map((row) => row.tgname),
    [
      'pds_enqueue_contributor_edits',
      'pds_enqueue_contributor_record',
      'pds_enqueue_contributors',
      'pds_enqueue_editions',
      'pds_enqueue_identifier_info',
      'pds_enqueue_identifiers',
      'pds_enqueue_publisher_edits',
      'pds_enqueue_publisher_record',
      'pds_enqueue_publishers'
    ]
  );
});

test('editions_next_tid() returns a 13-character TID and never repeats within a run', { skip: SKIP }, async () => {
  const one = await pool.query('SELECT editions_next_tid() AS rkey');
  assert.match(one.rows[0].rkey, /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);

  const many = await pool.query(
    'SELECT editions_next_tid() AS rkey FROM generate_series(1, 64)'
  );
  assert.equal(new Set(many.rows.map((row) => row.rkey)).size, 64);
  for (const row of many.rows) {
    assert.match(row.rkey, /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);
  }
});

test('ingest mints a TID edition, links entities and queues one create', { skip: SKIP }, async () => {
  const ingest = createIngest({ pool, publisherDid: AUTHORITY });
  const result = await ingest(candidate);

  assert.equal(result.created, true);
  assert.match(
    result.uri,
    new RegExp(`^at://${AUTHORITY}/${COLLECTION}/[234567abcdefghijklmnopqrstuvwxyz]{13}$`)
  );
  editionUri = result.uri;

  const edition = await pool.query('SELECT * FROM editions WHERE uri = $1', [editionUri]);
  assert.equal(edition.rowCount, 1);
  const row = edition.rows[0];
  editionRkey = row.rkey;
  assert.equal(editionUri, `at://${AUTHORITY}/${COLLECTION}/${row.rkey}`);
  assert.match(row.rkey, /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);
  assert.equal(row.title, candidate.title);
  assert.equal(row.subtitle, null);
  assert.equal(row.duration_seconds, 11_400);
  assert.equal(row.chapters, 12);
  assert.deepEqual(row.series, candidate.series);
  assert.equal(row.book_edition, 'first');
  assert.equal(row.cover_url, 'https://example.org/cover.jpg');
  assert.ok(row.created_at instanceof Date);
  assert.ok(row.indexed_at instanceof Date);

  const identifiers = await pool.query(
    `SELECT issuer, value FROM edition_identifiers
      WHERE edition_uri = $1 ORDER BY issuer, value`,
    [editionUri]
  );
  assert.deepEqual(identifiers.rows, [
    { issuer: 'googlebooks', value: 'schema-probe-volume' },
    { issuer: 'isbn13', value: ISBN }
  ]);

  // 0007 moved the shape claims onto the identifier: the candidate's claim is
  // written for every identifier it supplied, and the edition reads the union.
  const claims = await pool.query(
    `SELECT issuer, value, format, language, published_date, pages, description
       FROM edition_identifier_info
      WHERE edition_uri = $1 ORDER BY issuer, value`,
    [editionUri]
  );
  const claim = {
    format: 'paperback',
    language: 'en',
    published_date: '2026-11-11',
    pages: 321,
    description: 'A probe edition.'
  };
  assert.deepEqual(claims.rows, [
    { issuer: 'googlebooks', value: 'schema-probe-volume', ...claim },
    { issuer: 'isbn13', value: ISBN, ...claim }
  ]);

  const readModel = await pool.query(
    `SELECT language, published_date, format, pages, description
       FROM appview_book WHERE uri = $1`,
    [editionUri]
  );
  assert.deepEqual(readModel.rows[0], {
    language: 'en',
    published_date: '2026-11-11',
    format: 'paperback',
    pages: 321,
    description: 'A probe edition.'
  });

  const contributors = await pool.query(
    `SELECT c.name, c.description, ec.position, ec.role, ec.ref, c.identifiers
       FROM edition_contributors ec
       JOIN contributors c ON c.id = ec.contributor_id
      WHERE ec.edition_uri = $1`,
    [editionUri]
  );
  assert.deepEqual(contributors.rows, [{
    name: CONTRIBUTOR,
    description: 'A probe author bio.',
    position: 1,
    role: 'A01',
    ref: 'at://did:plc:probecontributor/community.lexicon.media.book.contributor/1',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }]
  }]);

  const publishers = await pool.query(
    `SELECT p.name, ip.issuer, ip.position, p.identifiers
       FROM edition_identifier_publishers ip
       JOIN publishers p ON p.id = ip.publisher_id
      WHERE ip.edition_uri = $1
      ORDER BY ip.issuer, ip.position`,
    [editionUri]
  );
  assert.deepEqual(publishers.rows, [{
    name: PUBLISHER,
    issuer: 'googlebooks',
    position: 1,
    identifiers: [{ issuer: 'isni', value: '0000000121032683' }]
  }, {
    name: PUBLISHER,
    issuer: 'isbn13',
    position: 1,
    identifiers: [{ issuer: 'isni', value: '0000000121032683' }]
  }]);

  // Ingest mints an address for each entity, and the 0004 trigger queues the
  // record next to the edition.
  const entities = await pool.query(
    `SELECT 'contributor' AS kind, at_uri FROM contributors WHERE name = $1
     UNION ALL
     SELECT 'publisher' AS kind, at_uri FROM publishers WHERE name = $2
     ORDER BY kind`,
    [CONTRIBUTOR, PUBLISHER]
  );
  assert.equal(entities.rowCount, 2);
  for (const entity of entities.rows) {
    assert.match(
      entity.at_uri,
      new RegExp(
        `^at://${AUTHORITY}/net\\.olamaelcu\\.livtet\\.biblio\\.(contributor|publisher)/` +
          '[234567abcdefghijklmnopqrstuvwxyz]{13}$'
      )
    );
  }

  const entityOutbox = await pool.query(
    'SELECT collection, op FROM pds_outbox WHERE collection <> $1 ORDER BY collection',
    [OUTBOX_COLLECTION]
  );
  assert.deepEqual(entityOutbox.rows, [
    { collection: 'net.olamaelcu.livtet.biblio.contributor', op: 'create' },
    { collection: 'net.olamaelcu.livtet.biblio.publisher', op: 'create' }
  ]);

  const outbox = await pool.query(
    'SELECT collection, rkey, op, value, attempts FROM pds_outbox WHERE uri = $1',
    [editionUri]
  );
  assert.deepEqual(outbox.rows, [{
    collection: OUTBOX_COLLECTION,
    rkey: editionRkey,
    op: 'create',
    value: null,
    attempts: 0
  }]);
});

test('re-ingesting the same identifier bag updates in place without downgrading the create', { skip: SKIP }, async () => {
  const ingest = createIngest({ pool, publisherDid: AUTHORITY });
  const result = await ingest({
    ...candidate,
    subtitle: 'Filled by a later provider',
    contributors: [{ ...candidate.contributors[0], description: 'Replacement bio.' }]
  });

  assert.deepEqual(result, { uri: editionUri, created: false });

  const count = await pool.query(
    'SELECT count(*)::int AS n FROM editions WHERE uri = $1',
    [editionUri]
  );
  assert.equal(count.rows[0].n, 1);

  const edition = await pool.query(
    'SELECT subtitle, title FROM editions WHERE uri = $1',
    [editionUri]
  );
  assert.equal(edition.rows[0].subtitle, 'Filled by a later provider');
  assert.equal(edition.rows[0].title, 'Schema Bootstrap Probe');

  const identifiers = await pool.query(
    'SELECT count(*)::int AS n FROM edition_identifiers WHERE edition_uri = $1',
    [editionUri]
  );
  assert.equal(identifiers.rows[0].n, 2);

  // A bio is filled once and never replaced, so a later provider cannot
  // overwrite the stored description.
  const bio = await pool.query('SELECT description FROM contributors WHERE name = $1', [
    CONTRIBUTOR
  ]);
  assert.equal(bio.rows[0].description, 'A probe author bio.');

  const outbox = await pool.query(
    'SELECT op FROM pds_outbox WHERE uri = $1',
    [editionUri]
  );
  // The initial create has not been published yet, so the trigger must not
  // downgrade it to update: the publisher still has to create the record.
  assert.equal(outbox.rows[0].op, 'create');
});

test('appview_book_lua exposes the text shape prelude.lua expects', { skip: SKIP }, async () => {
  const typed = await pool.query(
    `SELECT series, contributors, publisher, publishers, identifiers, created_at,
            pg_typeof(series)::text AS series_type,
            pg_typeof(contributors)::text AS contributors_type,
            pg_typeof(created_at)::text AS created_at_type
       FROM appview_book WHERE uri = $1`,
    [editionUri]
  );
  assert.equal(typed.rowCount, 1);
  assert.equal(typed.rows[0].series_type, 'jsonb');
  assert.equal(typed.rows[0].contributors_type, 'jsonb');
  assert.equal(typed.rows[0].created_at_type, 'timestamp with time zone');
  assert.deepEqual(typed.rows[0].series, candidate.series);
  assert.equal(typed.rows[0].publisher.name, PUBLISHER);
  assert.equal(typed.rows[0].publishers.length, 1);
  assert.deepEqual(typed.rows[0].identifiers, [
    { issuer: 'googlebooks', value: 'schema-probe-volume' },
    { issuer: 'isbn13', value: ISBN }
  ]);

  const lua = await pool.query(
    `SELECT series, contributors, publisher, publishers, identifiers, created_at,
            pg_typeof(series)::text AS series_type,
            pg_typeof(contributors)::text AS contributors_type,
            pg_typeof(publisher)::text AS publisher_type,
            pg_typeof(publishers)::text AS publishers_type,
            pg_typeof(identifiers)::text AS identifiers_type,
            pg_typeof(created_at)::text AS created_at_type
       FROM appview_book_lua WHERE uri = $1`,
    [editionUri]
  );
  assert.equal(lua.rowCount, 1);
  const row = lua.rows[0];
  for (const column of [
    'series',
    'contributors',
    'publisher',
    'publishers',
    'identifiers',
    'created_at'
  ]) {
    assert.equal(row[`${column}_type`], 'text', `${column} must be text for HappyView`);
    assert.equal(typeof row[column], 'string', `${column} must arrive as a string`);
  }
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // The equivalent of prelude.lua's edition_view(): decode the text columns and
  // build community.lexicon.media.book.defs#editionView.
  const contributors = JSON.parse(row.contributors);
  assert.deepEqual(contributors, [{
    position: 1,
    name: CONTRIBUTOR,
    role: 'A01',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    ref: 'at://did:plc:probecontributor/community.lexicon.media.book.contributor/1'
  }]);

  const editionViewContributors = contributors.map((entry) => {
    const contributor = { name: entry.name, role: entry.role ?? 'author' };
    if (entry.identifiers?.length > 0) contributor.identifiers = entry.identifiers;
    if (entry.ref !== undefined) contributor.ref = entry.ref;
    return contributor;
  });
  assert.deepEqual(editionViewContributors, [{
    name: CONTRIBUTOR,
    role: 'A01',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    ref: 'at://did:plc:probecontributor/community.lexicon.media.book.contributor/1'
  }]);

  assert.deepEqual(JSON.parse(row.series), candidate.series);
  const publisherAtUri = (
    await pool.query('SELECT at_uri FROM publishers WHERE name = $1', [PUBLISHER])
  ).rows[0].at_uri;
  assert.deepEqual(JSON.parse(row.publisher), {
    name: PUBLISHER,
    identifiers: [{ issuer: 'isni', value: '0000000121032683' }],
    ref: publisherAtUri
  });
  assert.deepEqual(JSON.parse(row.identifiers), [
    { issuer: 'googlebooks', value: 'schema-probe-volume' },
    { issuer: 'isbn13', value: ISBN }
  ]);
});

test('identifier containment matches the edge resolve query', { skip: SKIP }, async () => {
  const pairs = [JSON.stringify([{ issuer: 'orcid', value: '0000-0002-1825-0097' }])];
  const hit = await pool.query(
    'SELECT at_uri FROM contributors WHERE identifiers @> ANY($1::jsonb[])',
    [pairs]
  );
  assert.equal(hit.rowCount, 1);

  const miss = await pool.query(
    'SELECT at_uri FROM contributors WHERE identifiers @> ANY($1::jsonb[])',
    [[JSON.stringify([{ issuer: 'orcid', value: 'missing' }])]]
  );
  assert.equal(miss.rowCount, 0);
});

test('claimBatch, completeEntry and pds_cids work against the fresh schema', { skip: SKIP }, async () => {
  const claimed = await claimBatch(pool, {
    publisherDid: AUTHORITY,
    limit: 10,
    collections: [OUTBOX_COLLECTION]
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].uri, editionUri);
  assert.equal(claimed[0].rkey, editionRkey);
  assert.equal(claimed[0].op, 'create');
  assert.equal(claimed[0].collection, OUTBOX_COLLECTION);
  assert.ok(claimed[0].claimed_at);
  assert.ok(claimed[0].updated_at);

  const cid = 'bafyreicatalogschemacheck';
  assert.equal(await completeEntry(pool, claimed[0], { cid }), true);

  const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [editionUri]);
  assert.equal(outbox.rowCount, 0);

  const stored = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [editionUri]);
  assert.equal(stored.rows[0].cid, cid);
});

test('contributor/publisher edits and edition deletes enqueue update/delete and clear the CID', { skip: SKIP }, async () => {
  await pool.query('UPDATE contributors SET name = $1 WHERE name = $2', [
    CONTRIBUTOR_RENAMED,
    CONTRIBUTOR
  ]);

  const renamed = await pool.query('SELECT op, rkey FROM pds_outbox WHERE uri = $1', [
    editionUri
  ]);
  assert.deepEqual(renamed.rows[0], { op: 'update', rkey: editionRkey });

  let claimed = await claimBatch(pool, {
    publisherDid: AUTHORITY,
    limit: 10,
    collections: [OUTBOX_COLLECTION]
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].op, 'update');
  assert.equal(
    await completeEntry(pool, claimed[0], { cid: 'bafyreicatalogschemacheck2' }),
    true
  );

  await pool.query('UPDATE publishers SET name = $1 WHERE name = $2', [
    PUBLISHER_RENAMED,
    PUBLISHER
  ]);

  const publisherRenamed = await pool.query(
    'SELECT op, rkey FROM pds_outbox WHERE uri = $1',
    [editionUri]
  );
  assert.deepEqual(publisherRenamed.rows[0], { op: 'update', rkey: editionRkey });

  claimed = await claimBatch(pool, {
    publisherDid: AUTHORITY,
    limit: 10,
    collections: [OUTBOX_COLLECTION]
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].op, 'update');
  assert.equal(
    await completeEntry(pool, claimed[0], { cid: 'bafyreicatalogschemacheck3' }),
    true
  );

  await pool.query('DELETE FROM editions WHERE uri = $1', [editionUri]);

  const deleted = await pool.query('SELECT op, rkey FROM pds_outbox WHERE uri = $1', [
    editionUri
  ]);
  assert.deepEqual(deleted.rows[0], { op: 'delete', rkey: editionRkey });

  claimed = await claimBatch(pool, {
    publisherDid: AUTHORITY,
    limit: 10,
    collections: [OUTBOX_COLLECTION]
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].op, 'delete');
  assert.equal(await completeEntry(pool, claimed[0], { operation: 'delete' }), true);

  const cids = await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [editionUri]);
  assert.equal(cids.rowCount, 0);
  const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [editionUri]);
  assert.equal(outbox.rowCount, 0);
});

test('entity records are claimed across collections and keep their CIDs', { skip: SKIP }, async () => {
  const claimed = await claimBatch(pool, { publisherDid: AUTHORITY, limit: 10 });
  assert.deepEqual(
    claimed.map((entry) => entry.collection).sort(),
    ['net.olamaelcu.livtet.biblio.contributor', 'net.olamaelcu.livtet.biblio.publisher']
  );

  for (const entry of claimed) {
    assert.equal(await completeEntry(pool, entry, { cid: `bafy${entry.rkey}` }), true);
  }

  const remaining = await pool.query(
    'SELECT 1 FROM pds_outbox WHERE collection <> $1',
    [OUTBOX_COLLECTION]
  );
  assert.equal(remaining.rowCount, 0);

  const cids = await pool.query('SELECT uri FROM pds_cids WHERE uri LIKE $1', [
    `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.%`
  ]);
  assert.equal(cids.rowCount, 2);
});

test('entities.prepare mints once, queues the record, and is idempotent', { skip: SKIP }, async () => {
  const inserted = await pool.query(
    `INSERT INTO contributors (name, identifiers)
     VALUES ($1, '[]'::jsonb)
     RETURNING id, at_uri`,
    ['Catalog Schema Probe Prepare']
  );
  assert.equal(inserted.rows[0].at_uri, null);

  const quiet = { info() {} };
  const first = await prepareEntityRecords(pool, { authority: AUTHORITY, logger: quiet });
  assert.equal(first.contributorsMinted, 1);
  assert.equal(first.publishersMinted, 0);
  assert.equal(first.editionsQueued, 0);

  const minted = await pool.query('SELECT at_uri FROM contributors WHERE id = $1', [
    inserted.rows[0].id
  ]);
  assert.match(
    minted.rows[0].at_uri,
    new RegExp(
      `^at://${AUTHORITY}/net\\.olamaelcu\\.livtet\\.biblio\\.contributor/` +
        '[234567abcdefghijklmnopqrstuvwxyz]{13}$'
    )
  );
  const queued = await pool.query('SELECT collection, op FROM pds_outbox WHERE uri = $1', [
    minted.rows[0].at_uri
  ]);
  assert.deepEqual(queued.rows, [
    { collection: 'net.olamaelcu.livtet.biblio.contributor', op: 'create' }
  ]);

  const second = await prepareEntityRecords(pool, { authority: AUTHORITY, logger: quiet });
  assert.deepEqual(second, {
    phase: 'mint',
    contributorsMinted: 0,
    publishersMinted: 0,
    entityRowsQueued: 0,
    editionsQueued: 0
  });
});
