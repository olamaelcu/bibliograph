/**
 * Fresh-database verification for packages/worker/sql/0001-catalog-schema.sql.
 *
 * These tests need an *empty* scratch database and are skipped by default so
 * `pnpm test` stays safe against the normal development
 * database. `mise run catalog-schema-check` creates and drops that database:
 *
 *   CATALOG_SCHEMA_TEST_DATABASE_URL=postgres://…/scratch pnpm exec vitest run test/catalog-schema.test.js
 *
 * The schema is applied through the same SQL file the deployment uses, then the
 * real worker ingest/claim/complete code is exercised against it.
 */

import { expect, test, afterAll, beforeAll } from 'vitest';

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
  await pool.query('DELETE FROM books WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM contributors WHERE name LIKE $1', ['Catalog Schema Probe%']);
  await pool.query('DELETE FROM publishers WHERE name LIKE $1', ['Catalog Schema Probe%']);
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  await applySchema();
  await cleanup();
});

afterAll(async () => {
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
      'book_search',
      'books',
      'catalog_enqueue_marks',
      'contributors',
      'edition_contributors',
      'edition_cover_fetches',
      'edition_genre_fetches',
      'edition_genres',
      'edition_identifier_info',
      'edition_identifier_publishers',
      'edition_identifiers',
      'edition_publisher_list',
      'edition_shape',
      'genres',
      'google_books_cache',
      'isbndb_cache',
      'language_aliases',
      'pds_cids',
      'pds_outbox',
      'provider_daily_usage',
      'publishers'
    ]]
  );
  expect(tables.rows.map((row) => row.table_name)).toEqual([
      'book_search',
      'books',
      'catalog_enqueue_marks',
      'contributors',
      'edition_contributors',
      'edition_cover_fetches',
      'edition_genre_fetches',
      'edition_genres',
      'edition_identifier_info',
      'edition_identifier_publishers',
      'edition_identifiers',
      'edition_publisher_list',
      'edition_shape',
      'genres',
      'google_books_cache',
      'isbndb_cache',
      'language_aliases',
      'pds_cids',
      'pds_outbox',
      'provider_daily_usage',
      'publishers'
    ]);

  const views = await pool.query(
    `SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name`,
    [['appview_book', 'appview_book_lua', 'edition_identifier_shape', 'edition_publishers_shape']]
  );
  expect(views.rows.map((row) => row.table_name)).toEqual(['appview_book', 'appview_book_lua', 'edition_identifier_shape', 'edition_publishers_shape']);

  const functions = await pool.query(
    `SELECT proname FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = ANY($1)
      ORDER BY proname`,
    [[
      'catalog_enqueue_cover_fetch',
      'catalog_enqueue_genre_fetch',
      'editions_next_tid',
      'editions_tid_encode',
      'identifier_format_is_audio',
      'normalize_identifier_extent',
      'normalize_identifier_extent_row',
      'normalize_identifier_language',
      'normalize_language',
      'pds_enqueue_contributor_editions',
      'pds_enqueue_edition',
      'pds_enqueue_edition_child',
      'pds_enqueue_entity',
      'pds_enqueue_publisher_editions',
      'refresh_edition_publishers',
      'refresh_edition_publishers_statement',
      'refresh_edition_shape',
      'refresh_edition_shape_statement'
    ]]
  );
  expect(functions.rows.length).toBe(18);

  // 0013 makes the three claim columns projections of `extent`, so no writer
  // can set them directly and the shape view reads a single consistent claim.
  const claimColumns = await pool.query(
    `SELECT column_name, is_generated FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'edition_identifier_info'
        AND column_name = ANY($1)
      ORDER BY column_name`,
    [['duration_seconds', 'format', 'pages']]
  );
  expect(claimColumns.rows).toEqual([
    { column_name: 'duration_seconds', is_generated: 'ALWAYS' },
    { column_name: 'format', is_generated: 'ALWAYS' },
    { column_name: 'pages', is_generated: 'ALWAYS' }
  ]);

  const triggers = await pool.query(
    `SELECT tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
      ORDER BY tgname`
  );
  expect(triggers.rows.map((row) => row.tgname)).toEqual([
      'book_search_books_delete',
      'book_search_books_insert',
      'book_search_books_update',
      'book_search_edition_contributors_delete',
      'book_search_edition_contributors_insert',
      'book_search_edition_contributors_update',
      'book_search_edition_identifiers_delete',
      'book_search_edition_identifiers_insert',
      'book_search_edition_identifiers_update',
      'book_search_edition_shape_delete',
      'book_search_edition_shape_insert',
      'book_search_edition_shape_update',
      'normalize_identifier_extent',
      'normalize_identifier_language',
      'pds_enqueue_contributor_edits',
      'pds_enqueue_contributor_record',
      'pds_enqueue_contributors',
      'pds_enqueue_editions',
      'pds_enqueue_identifier_info',
      'pds_enqueue_identifiers',
      'pds_enqueue_publisher_edits',
      'pds_enqueue_publisher_record',
      'pds_enqueue_publishers',
      'refresh_edition_publishers_delete',
      'refresh_edition_publishers_insert',
      'refresh_edition_publishers_update',
      'refresh_edition_shape_delete',
      'refresh_edition_shape_insert',
      'refresh_edition_shape_update'
    ]);
});

test('editions_next_tid() returns a 13-character TID and never repeats within a run', { skip: SKIP }, async () => {
  const one = await pool.query('SELECT editions_next_tid() AS rkey');
  expect(one.rows[0].rkey).toMatch(/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);

  const many = await pool.query(
    'SELECT editions_next_tid() AS rkey FROM generate_series(1, 64)'
  );
  expect(new Set(many.rows.map((row) => row.rkey)).size).toBe(64);
  for (const row of many.rows) {
    expect(row.rkey).toMatch(/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);
  }
});

test('ingest mints a TID edition, links entities and queues one create', { skip: SKIP }, async () => {
  const ingest = createIngest({ pool, publisherDid: AUTHORITY });
  const result = await ingest(candidate);

  expect(result.created).toBe(true);
  expect(result.uri).toMatch(new RegExp(`^at://${AUTHORITY}/${COLLECTION}/[234567abcdefghijklmnopqrstuvwxyz]{13}$`));
  editionUri = result.uri;

  const edition = await pool.query('SELECT * FROM books WHERE uri = $1', [editionUri]);
  expect(edition.rowCount).toBe(1);
  const row = edition.rows[0];
  editionRkey = row.rkey;
  expect(editionUri).toBe(`at://${AUTHORITY}/${COLLECTION}/${row.rkey}`);
  expect(row.rkey).toMatch(/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);
  expect(row.title).toBe(candidate.title);
  expect(row.subtitle).toBe(null);
  expect(row.chapters).toBe(12);
  expect(row.series).toEqual(candidate.series);
  expect(row.book_edition).toBe('first');
  expect(row.cover_url).toBe('https://example.org/cover.jpg');
  expect(row.created_at instanceof Date).toBeTruthy();
  expect(row.indexed_at instanceof Date).toBeTruthy();

  const identifiers = await pool.query(
    `SELECT issuer, value FROM edition_identifiers
      WHERE edition_uri = $1 ORDER BY issuer, value`,
    [editionUri]
  );
  expect(identifiers.rows).toEqual([
    { issuer: 'googlebooks', value: 'schema-probe-volume' },
    { issuer: 'isbn13', value: ISBN }
  ]);

  // 0007 moved the shape claims onto the identifier: the candidate's claim is
  // written for every identifier it supplied, and the edition reads the union.
  const claims = await pool.query(
    `SELECT issuer, value, format, language, published_date, pages, description,
            duration_seconds, extent
       FROM edition_identifier_info
      WHERE edition_uri = $1 ORDER BY issuer, value`,
    [editionUri]
  );
  // 0013: `paperback` is a print format, so the candidate's 11_400-second
  // duration is pruned and only the page count survives the claim.
  const claim = {
    extent: { format: 'paperback', pages: 321 },
    format: 'paperback',
    language: 'en',
    published_date: '2026-11-11',
    pages: 321,
    description: 'A probe edition.',
    duration_seconds: null
  };
  expect(claims.rows).toEqual([
    { issuer: 'googlebooks', value: 'schema-probe-volume', ...claim },
    { issuer: 'isbn13', value: ISBN, ...claim }
  ]);

  const readModel = await pool.query(
    `SELECT language, published_date, format, pages, description, duration_seconds
       FROM appview_book WHERE uri = $1`,
    [editionUri]
  );
  expect(readModel.rows[0]).toEqual({
    language: 'en',
    published_date: '2026-11-11',
    format: 'paperback',
    pages: 321,
    description: 'A probe edition.',
    duration_seconds: null
  });

  // 0010 moved the duration onto the identifier; no edition keeps one.
  const durationColumn = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'books'
        AND column_name = 'duration_seconds'`
  );
  expect(durationColumn.rowCount, 'editions no longer holds a duration').toBe(0);

  const contributors = await pool.query(
    `SELECT c.name, c.description, ec.position, ec.role, ec.ref, c.identifiers
       FROM edition_contributors ec
       JOIN contributors c ON c.id = ec.contributor_id
      WHERE ec.edition_uri = $1`,
    [editionUri]
  );
  expect(contributors.rows).toEqual([{
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
  expect(publishers.rows).toEqual([{
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
  expect(entities.rowCount).toBe(2);
  for (const entity of entities.rows) {
    expect(entity.at_uri).toMatch(new RegExp(
        `^at://${AUTHORITY}/net\\.olamaelcu\\.livtet\\.biblio\\.(contributor|publisher)/` +
          '[234567abcdefghijklmnopqrstuvwxyz]{13}$'
      ));
  }

  const entityOutbox = await pool.query(
    'SELECT collection, op FROM pds_outbox WHERE collection <> $1 ORDER BY collection',
    [OUTBOX_COLLECTION]
  );
  expect(entityOutbox.rows).toEqual([
    { collection: 'net.olamaelcu.livtet.biblio.contributor', op: 'create' },
    { collection: 'net.olamaelcu.livtet.biblio.publisher', op: 'create' }
  ]);

  const outbox = await pool.query(
    'SELECT collection, rkey, op, value, attempts FROM pds_outbox WHERE uri = $1',
    [editionUri]
  );
  expect(outbox.rows).toEqual([{
    collection: OUTBOX_COLLECTION,
    rkey: editionRkey,
    op: 'create',
    value: null,
    attempts: 0
  }]);
});

test('an extent keeps only the unit its format uses, and the shape publishes one', { skip: SKIP }, async () => {
  // A print claim and an audio claim on the same book, plus a second edition
  // that is audio-only. The BEFORE trigger prunes the unit the row's format
  // does not use, and the shape view publishes the winner's unit only.
  const audioOnly = `at://${AUTHORITY}/${COLLECTION}/extent-audio`;
  const mixed = `at://${AUTHORITY}/${COLLECTION}/extent-mixed`;

  // Rolled back: the outbox tests later in this file assume the probe edition
  // is the only queued record.
  const client = await pool.connect();
  let claims;
  let shape;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO books (uri, title, created_at)
       VALUES ($1, 'Audio Only Probe', now()), ($2, 'Mixed Format Probe', now())`,
      [audioOnly, mixed]
    );
    await client.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value) VALUES
         ($1, 'isbn13', '9780306406159'),
         ($2, 'isbn13', '9780306406158'),
         ($2, 'isbn10', '0306406152')`,
      [audioOnly, mixed]
    );
    await client.query(
      `INSERT INTO edition_identifier_info (edition_uri, issuer, value, extent) VALUES
         ($1, 'isbn13', '9780306406159',
          '{"format":"Audiobook","durationSeconds":36000}'),
         ($2, 'isbn13', '9780306406158',
          '{"format":"hardcover","pages":300,"durationSeconds":99999}'),
         ($2, 'isbn10', '0306406152',
          '{"format":"Audiobook","durationSeconds":36000}')`,
      [audioOnly, mixed]
    );

    claims = await client.query(
      `SELECT edition_uri, issuer, extent, format, pages, duration_seconds
         FROM edition_identifier_info
        WHERE edition_uri = ANY($1::text[])
        ORDER BY edition_uri, issuer`,
      [[audioOnly, mixed]]
    );
    shape = await client.query(
      `SELECT edition_uri, format, pages, duration_seconds
         FROM edition_identifier_shape
        WHERE edition_uri = ANY($1::text[])
        ORDER BY edition_uri`,
      [[audioOnly, mixed]]
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }

  const audioClaim = {
    extent: { format: 'Audiobook', durationSeconds: 36000 },
    format: 'Audiobook',
    pages: null,
    duration_seconds: 36000
  };
  expect(claims.rows).toEqual([
    { edition_uri: audioOnly, issuer: 'isbn13', ...audioClaim },
    { edition_uri: mixed, issuer: 'isbn10', ...audioClaim },
    {
      edition_uri: mixed,
      issuer: 'isbn13',
      extent: { format: 'hardcover', pages: 300 },
      format: 'hardcover',
      pages: 300,
      duration_seconds: null
    }
  ]);
  expect(shape.rows).toEqual([
    { edition_uri: audioOnly, format: 'Audiobook', pages: null, duration_seconds: 36000 },
    { edition_uri: mixed, format: 'hardcover', pages: 300, duration_seconds: null }
  ]);
});

// 0015 refreshed the shape from a FOR EACH ROW trigger, so N claim rows cost N
// aggregations and each aggregation re-read all N rows: O(N²) for one ingest,
// plus a rewritten `edition_shape` row every time. 0023 makes the refresh
// statement-level, so one statement over ten claims refreshes the edition once,
// and guards the upsert, so a refresh that computes the stored row writes no
// tuple at all.
test('one statement refreshes an edition shape once, and an unchanged claim writes nothing', { skip: SKIP }, async () => {
  const probe = `at://${AUTHORITY}/${COLLECTION}/shape-statement-probe`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO books (uri, title, created_at)
       VALUES ($1, 'Statement Trigger Probe', now())`,
      [probe]
    );
    await client.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value)
       SELECT $1, 'isbn10', 'probe-' || g FROM generate_series(1, 10) g
       UNION ALL
       SELECT $1, 'openlibrary', 'ol-probe'`,
      [probe]
    );

    // A row-level counter on edition_shape records the row versions actually
    // written, which is what `pg_stat_user_tables.n_tup_upd` reports, without
    // the stats collector's lag inside the transaction this test rolls back.
    await client.query('DROP TABLE IF EXISTS shape_write_probe');
    await client.query(
      'CREATE TABLE shape_write_probe (id bigserial PRIMARY KEY, op text NOT NULL)'
    );
    await client.query(`
      CREATE OR REPLACE FUNCTION shape_write_probe_record() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        INSERT INTO shape_write_probe (op) VALUES (TG_OP);
        RETURN NULL;
      END
      $function$
    `);
    await client.query('DROP TRIGGER IF EXISTS shape_write_probe ON edition_shape');
    await client.query(
      `CREATE TRIGGER shape_write_probe
         AFTER INSERT OR UPDATE OR DELETE ON edition_shape
         FOR EACH ROW EXECUTE FUNCTION shape_write_probe_record()`
    );
    const writes = async () => {
      const counted = await client.query('SELECT count(*)::int AS n FROM shape_write_probe');
      await client.query('DELETE FROM shape_write_probe');
      return counted.rows[0].n;
    };

    // Seed one shape row so the batch below is an update, not an insert.
    await client.query(
      `INSERT INTO edition_identifier_info (edition_uri, issuer, value, extent)
       VALUES ($1, 'openlibrary', 'ol-probe', '{"format":"hardcover","pages":100}')`,
      [probe]
    );
    expect(await writes()).toBe(1);

    // Ten claims in ONE statement: the statement trigger sees a single
    // `changed` transition table and refreshes the edition once, not ten times.
    await client.query(
      `INSERT INTO edition_identifier_info (edition_uri, issuer, value, extent)
       SELECT $1, 'isbn10', 'probe-' || g,
              jsonb_build_object('format', 'paperback', 'pages', 200 + g)
         FROM generate_series(1, 10) g`,
      [probe]
    );
    expect(await writes()).toBe(1);

    const claims = await client.query(
      'SELECT count(*)::int AS n FROM edition_identifier_info WHERE edition_uri = $1',
      [probe]
    );
    expect(claims.rows[0].n).toBe(11);

    // One UPDATE over all ten claims also refreshes once.
    await client.query(
      `UPDATE edition_identifier_info SET description = 'Statement batch'
        WHERE edition_uri = $1 AND issuer = 'isbn10'`,
      [probe]
    );
    expect(await writes()).toBe(1);

    // isbn10 outranks `openlibrary`, so the batch's first claim wins the shape.
    const stored = await client.query(
      `SELECT updated_at::text AS at, format, pages, description
         FROM edition_shape WHERE edition_uri = $1`,
      [probe]
    );
    expect(stored.rows[0]).toMatchObject({
      format: 'paperback',
      pages: 201,
      description: 'Statement batch'
    });

    // The same value written again: the aggregate is identical, so the guard in
    // refresh_edition_shape skips the upsert and edition_shape is untouched.
    await client.query(
      `UPDATE edition_identifier_info SET extent = extent
        WHERE edition_uri = $1 AND issuer = 'isbn10' AND value = 'probe-1'`,
      [probe]
    );
    expect(await writes()).toBe(0);

    const after = await client.query(
      'SELECT updated_at::text AS at FROM edition_shape WHERE edition_uri = $1',
      [probe]
    );
    expect(after.rows[0].at).toBe(stored.rows[0].at);

    // A claim re-keyed onto another edition changes two shapes. The update
    // trigger names both transition tables, so the edition the claim left is
    // refreshed from `old_changed` (the winner moves away, so `probe` falls back
    // to the next claim's pages) and the edition it joined from `changed`.
    const rekeyed = `at://${AUTHORITY}/${COLLECTION}/shape-statement-probe-rekey`;
    await client.query(
      `INSERT INTO books (uri, title, created_at)
       VALUES ($1, 'Rekey Probe', now())`,
      [rekeyed]
    );
    await client.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value) VALUES
         ($1, 'isbn10', 'probe-1')`,
      [rekeyed]
    );
    await client.query(
      `UPDATE edition_identifier_info SET edition_uri = $2
        WHERE edition_uri = $1 AND issuer = 'isbn10' AND value = 'probe-1'`,
      [probe, rekeyed]
    );
    expect(await writes()).toBe(2);

    const moved = await client.query(
      `SELECT edition_uri, format, pages FROM edition_shape
        WHERE edition_uri = ANY($1::text[]) ORDER BY edition_uri`,
      [[probe, rekeyed]]
    );
    expect(moved.rows).toEqual([
      // Values order as text, so the loser that wins next is 'probe-10'.
      { edition_uri: probe, format: 'paperback', pages: 210 },
      { edition_uri: rekeyed, format: 'paperback', pages: 201 }
    ]);

    // Deleting every claim in one statement still drops the row once, which is
    // the `GROUP BY`-produced-no-row behaviour 0015 preserved.
    await client.query('DELETE FROM edition_identifier_info WHERE edition_uri = $1', [probe]);
    expect(await writes()).toBe(1);
    const gone = await client.query(
      'SELECT count(*)::int AS n FROM edition_shape WHERE edition_uri = $1',
      [probe]
    );
    expect(gone.rows[0].n).toBe(0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('re-ingesting the same identifier bag updates in place without downgrading the create', { skip: SKIP }, async () => {
  const ingest = createIngest({ pool, publisherDid: AUTHORITY });
  const result = await ingest({
    ...candidate,
    subtitle: 'Filled by a later provider',
    contributors: [{ ...candidate.contributors[0], description: 'Replacement bio.' }]
  });

  expect(result).toEqual({ uri: editionUri, created: false });

  const count = await pool.query(
    'SELECT count(*)::int AS n FROM books WHERE uri = $1',
    [editionUri]
  );
  expect(count.rows[0].n).toBe(1);

  const edition = await pool.query(
    'SELECT subtitle, title FROM books WHERE uri = $1',
    [editionUri]
  );
  expect(edition.rows[0].subtitle).toBe('Filled by a later provider');
  expect(edition.rows[0].title).toBe('Schema Bootstrap Probe');

  const identifiers = await pool.query(
    'SELECT count(*)::int AS n FROM edition_identifiers WHERE edition_uri = $1',
    [editionUri]
  );
  expect(identifiers.rows[0].n).toBe(2);

  // A bio is filled once and never replaced, so a later provider cannot
  // overwrite the stored description.
  const bio = await pool.query('SELECT description FROM contributors WHERE name = $1', [
    CONTRIBUTOR
  ]);
  expect(bio.rows[0].description).toBe('A probe author bio.');

  const outbox = await pool.query(
    'SELECT op FROM pds_outbox WHERE uri = $1',
    [editionUri]
  );
  // The initial create has not been published yet, so the trigger must not
  // downgrade it to update: the publisher still has to create the record.
  expect(outbox.rows[0].op).toBe('create');
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
  expect(typed.rowCount).toBe(1);
  expect(typed.rows[0].series_type).toBe('jsonb');
  expect(typed.rows[0].contributors_type).toBe('jsonb');
  expect(typed.rows[0].created_at_type).toBe('timestamp with time zone');
  expect(typed.rows[0].series).toEqual(candidate.series);
  expect(typed.rows[0].publisher.name).toBe(PUBLISHER);
  expect(typed.rows[0].publishers.length).toBe(1);
  expect(typed.rows[0].identifiers).toEqual([
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
  expect(lua.rowCount).toBe(1);
  const row = lua.rows[0];
  for (const column of [
    'series',
    'contributors',
    'publisher',
    'publishers',
    'identifiers',
    'created_at'
  ]) {
    expect(row[`${column}_type`], `${column} must be text for HappyView`).toBe('text');
    expect(typeof row[column], `${column} must arrive as a string`).toBe('string');
  }
  expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // The equivalent of prelude.lua's edition_view(): decode the text columns and
  // build community.lexicon.media.book.defs#editionView.
  const contributors = JSON.parse(row.contributors);
  expect(contributors).toEqual([{
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
  expect(editionViewContributors).toEqual([{
    name: CONTRIBUTOR,
    role: 'A01',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    ref: 'at://did:plc:probecontributor/community.lexicon.media.book.contributor/1'
  }]);

  expect(JSON.parse(row.series)).toEqual(candidate.series);
  const publisherAtUri = (
    await pool.query('SELECT at_uri FROM publishers WHERE name = $1', [PUBLISHER])
  ).rows[0].at_uri;
  expect(JSON.parse(row.publisher)).toEqual({
    name: PUBLISHER,
    identifiers: [{ issuer: 'isni', value: '0000000121032683' }],
    ref: publisherAtUri
  });
  expect(JSON.parse(row.identifiers)).toEqual([
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
  expect(hit.rowCount).toBe(1);

  const miss = await pool.query(
    'SELECT at_uri FROM contributors WHERE identifiers @> ANY($1::jsonb[])',
    [[JSON.stringify([{ issuer: 'orcid', value: 'missing' }])]]
  );
  expect(miss.rowCount).toBe(0);
});

test('claimBatch, completeEntry and pds_cids work against the fresh schema', { skip: SKIP }, async () => {
  const claimed = await claimBatch(pool, {
    publisherDid: AUTHORITY,
    limit: 10,
    collections: [OUTBOX_COLLECTION]
  });
  expect(claimed.length).toBe(1);
  expect(claimed[0].uri).toBe(editionUri);
  expect(claimed[0].rkey).toBe(editionRkey);
  expect(claimed[0].op).toBe('create');
  expect(claimed[0].collection).toBe(OUTBOX_COLLECTION);
  expect(claimed[0].claimed_at).toBeTruthy();
  expect(claimed[0].updated_at).toBeTruthy();

  const cid = 'bafyreicatalogschemacheck';
  expect(await completeEntry(pool, claimed[0], { cid })).toBe(true);

  const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [editionUri]);
  expect(outbox.rowCount).toBe(0);

  const stored = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [editionUri]);
  expect(stored.rows[0].cid).toBe(cid);
});

// A re-ingest upserts the same entity values and the same links. `ON CONFLICT
// ... DO UPDATE` is an UPDATE even when nothing changed, and without the guards
// it re-queued the edition and both entity records on every ingest of a known
// edition: 93M outbox rows on production for ~300k entity writes.
test('re-ingesting an unchanged edition queues nothing', { skip: SKIP }, async () => {
  const before = await pool.query('SELECT uri, op, updated_at FROM pds_outbox ORDER BY uri');

  const ingest = createIngest({ pool, publisherDid: AUTHORITY });
  const again = await ingest(candidate);
  expect(again.uri).toBe(editionUri);
  expect(again.created).toBe(false);

  const after = await pool.query('SELECT uri, op, updated_at FROM pds_outbox ORDER BY uri');
  expect(after.rows).toEqual(before.rows);

  const requeued = await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [editionUri]);
  expect(requeued.rowCount).toBe(0);
});

test('contributor/publisher edits and edition deletes enqueue update/delete and clear the CID', { skip: SKIP }, async () => {
  await pool.query('UPDATE contributors SET name = $1 WHERE name = $2', [
    CONTRIBUTOR_RENAMED,
    CONTRIBUTOR
  ]);

  const renamed = await pool.query('SELECT op, rkey FROM pds_outbox WHERE uri = $1', [
    editionUri
  ]);
  expect(renamed.rows[0]).toEqual({ op: 'update', rkey: editionRkey });

  let claimed = await claimBatch(pool, {
    publisherDid: AUTHORITY,
    limit: 10,
    collections: [OUTBOX_COLLECTION]
  });
  expect(claimed.length).toBe(1);
  expect(claimed[0].op).toBe('update');
  expect(await completeEntry(pool, claimed[0], { cid: 'bafyreicatalogschemacheck2' })).toBe(true);

  await pool.query('UPDATE publishers SET name = $1 WHERE name = $2', [
    PUBLISHER_RENAMED,
    PUBLISHER
  ]);

  const publisherRenamed = await pool.query(
    'SELECT op, rkey FROM pds_outbox WHERE uri = $1',
    [editionUri]
  );
  expect(publisherRenamed.rows[0]).toEqual({ op: 'update', rkey: editionRkey });

  claimed = await claimBatch(pool, {
    publisherDid: AUTHORITY,
    limit: 10,
    collections: [OUTBOX_COLLECTION]
  });
  expect(claimed.length).toBe(1);
  expect(claimed[0].op).toBe('update');
  expect(await completeEntry(pool, claimed[0], { cid: 'bafyreicatalogschemacheck3' })).toBe(true);

  await pool.query('DELETE FROM books WHERE uri = $1', [editionUri]);

  const deleted = await pool.query('SELECT op, rkey FROM pds_outbox WHERE uri = $1', [
    editionUri
  ]);
  expect(deleted.rows[0]).toEqual({ op: 'delete', rkey: editionRkey });

  claimed = await claimBatch(pool, {
    publisherDid: AUTHORITY,
    limit: 10,
    collections: [OUTBOX_COLLECTION]
  });
  expect(claimed.length).toBe(1);
  expect(claimed[0].op).toBe('delete');
  expect(await completeEntry(pool, claimed[0], { operation: 'delete' })).toBe(true);

  const cids = await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [editionUri]);
  expect(cids.rowCount).toBe(0);
  const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [editionUri]);
  expect(outbox.rowCount).toBe(0);
});

test('entity records are claimed across collections and keep their CIDs', { skip: SKIP }, async () => {
  const claimed = await claimBatch(pool, { publisherDid: AUTHORITY, limit: 10 });
  expect(claimed.map((entry) => entry.collection).sort()).toEqual(['net.olamaelcu.livtet.biblio.contributor', 'net.olamaelcu.livtet.biblio.publisher']);

  for (const entry of claimed) {
    expect(await completeEntry(pool, entry, { cid: `bafy${entry.rkey}` })).toBe(true);
  }

  const remaining = await pool.query(
    'SELECT 1 FROM pds_outbox WHERE collection <> $1',
    [OUTBOX_COLLECTION]
  );
  expect(remaining.rowCount).toBe(0);

  const cids = await pool.query('SELECT uri FROM pds_cids WHERE uri LIKE $1', [
    `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.%`
  ]);
  expect(cids.rowCount).toBe(2);
});

test('entities.prepare mints once, queues the record, and is idempotent', { skip: SKIP }, async () => {
  const inserted = await pool.query(
    `INSERT INTO contributors (name, identifiers)
     VALUES ($1, '[]'::jsonb)
     RETURNING id, at_uri`,
    ['Catalog Schema Probe Prepare']
  );
  expect(inserted.rows[0].at_uri).toBe(null);

  const quiet = { info() {} };
  const first = await prepareEntityRecords(pool, { authority: AUTHORITY, logger: quiet });
  expect(first.contributorsMinted).toBe(1);
  expect(first.publishersMinted).toBe(0);
  expect(first.editionsQueued).toBe(0);

  const minted = await pool.query('SELECT at_uri FROM contributors WHERE id = $1', [
    inserted.rows[0].id
  ]);
  expect(minted.rows[0].at_uri).toMatch(new RegExp(
      `^at://${AUTHORITY}/net\\.olamaelcu\\.livtet\\.biblio\\.contributor/` +
        '[234567abcdefghijklmnopqrstuvwxyz]{13}$'
    ));
  const queued = await pool.query('SELECT collection, op FROM pds_outbox WHERE uri = $1', [
    minted.rows[0].at_uri
  ]);
  expect(queued.rows).toEqual([
    { collection: 'net.olamaelcu.livtet.biblio.contributor', op: 'create' }
  ]);

  const second = await prepareEntityRecords(pool, { authority: AUTHORITY, logger: quiet });
  expect(second).toEqual({
    phase: 'mint',
    contributorsMinted: 0,
    publishersMinted: 0,
    entityRowsQueued: 0,
    editionsQueued: 0
  });
});

test('language claims are normalized to a single BCP 47 spelling', { skip: SKIP }, async () => {
  const ingest = createIngest({ pool, publisherDid: AUTHORITY });
  const result = await ingest({
    identifiers: [{ issuer: 'isbn13', value: '9780000009911' }],
    title: 'Language normalization probe',
    language: 'ENG'
  });
  expect(result?.uri).toBeTruthy();

  // The claim trigger rewrites the provider's ISO 639-2 code on write, so the
  // stored value and the edition's public shape agree with curation's BCP 47.
  const claim = await pool.query(
    'SELECT language FROM edition_identifier_info WHERE edition_uri = $1',
    [result.uri]
  );
  expect(claim.rows).toEqual([{ language: 'en' }]);

  const shape = await pool.query(
    'SELECT language FROM edition_identifier_shape WHERE edition_uri = $1',
    [result.uri]
  );
  expect(shape.rows).toEqual([{ language: 'en' }]);

  // Both ISO 639-2 forms map, a region suffix survives, and a code the alias
  // table does not know is only trimmed.
  const normalized = await pool.query(
    `SELECT normalize_language('fre') AS fre,
            normalize_language('fra') AS fra,
            normalize_language('ENG-us') AS mixed,
            normalize_language('en') AS plain,
            normalize_language('zzz') AS unknown,
            normalize_language('  ') AS blank`
  );
  expect(normalized.rows[0]).toEqual({
    fre: 'fr',
    fra: 'fr',
    mixed: 'en-us',
    plain: 'en',
    unknown: 'zzz',
    blank: null
  });
});

// The catalog table is `books`; `editions` survives only as the one-release
// compatibility view 0021 creates. A table named `editions` here means a
// historical file still creates one, which is exactly the replay bug 0000 exists
// to prevent.
test('the catalog table is books, and editions is only the compatibility view', { skip: SKIP }, async () => {
  const { rows } = await pool.query(
    `SELECT to_regclass('public.books') IS NOT NULL AS has_books,
            (SELECT relkind::text FROM pg_class
              WHERE oid = to_regclass('public.editions')) AS editions_kind`
  );
  expect(rows[0].has_books).toBe(true);
  expect(rows[0].editions_kind).not.toBe('r');
});
