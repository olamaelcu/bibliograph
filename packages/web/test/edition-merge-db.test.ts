/**
 * Edition merge against the development catalog.
 *
 * The merge is the one admin write that deletes rows: identifiers, credits and
 * publisher links are rebuilt on the base and every other edition is dropped.
 * These tests drive the real transaction against `DATABASE_URL` (skipping when
 * it is unreachable) and assert the per-identifier publisher links, which have
 * no other integration coverage.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { MergeError, mergeEditions } from '../src/lib/server/admin/merge.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = `${process.pid}-${Date.now()}`;
const AUTHORITY = `did:plc:editionmerge${process.pid}`;
const EDITION_COLLECTION = 'community.lexicon.media.book.edition';
const CONTRIBUTOR_COLLECTION = 'net.olamaelcu.livtet.biblio.contributor';
const PUBLISHER_COLLECTION = 'net.olamaelcu.livtet.biblio.publisher';

let pool: pg.Pool | undefined;
let ready = false;
let sequence = 0;

function label(): string {
  sequence += 1;
  return `merge${RUN.replace(/[^a-z0-9]/gi, '')}${sequence}`;
}

function requiredPool(t: { skip: (message?: string) => void }): pg.Pool | null {
  if (!ready || !pool) {
    t.skip('DATABASE_URL is not reachable; skipping catalog integration tests');
    return null;
  }
  return pool;
}

const editionUri = (rkey: string): string => `at://${AUTHORITY}/${EDITION_COLLECTION}/${rkey}`;

async function cleanup(): Promise<void> {
  if (!pool) return;
  const prefix = `at://${AUTHORITY}/%`;
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM contributors WHERE at_uri LIKE $1 OR name LIKE $2', [
    prefix,
    `${RUN}%`
  ]);
  await pool.query('DELETE FROM publishers WHERE at_uri LIKE $1 OR name LIKE $2', [
    prefix,
    `${RUN}%`
  ]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [prefix]);
}

async function createContributor(name: string): Promise<number> {
  const result = await (pool as pg.Pool).query<{ id: string }>(
    `INSERT INTO contributors (name, identifiers, at_uri)
     VALUES ($1, '[]'::jsonb, 'at://' || $2 || '/' || $3 || '/' || editions_next_tid())
     RETURNING id`,
    [name, AUTHORITY, CONTRIBUTOR_COLLECTION]
  );
  return Number(result.rows[0]?.id);
}

async function createPublisher(name: string): Promise<number> {
  const result = await (pool as pg.Pool).query<{ id: string }>(
    `INSERT INTO publishers (name, identifiers, at_uri)
     VALUES ($1, '[]'::jsonb, 'at://' || $2 || '/' || $3 || '/' || editions_next_tid())
     RETURNING id`,
    [name, AUTHORITY, PUBLISHER_COLLECTION]
  );
  return Number(result.rows[0]?.id);
}

type SeedIdentifier = { issuer: string; value: string; publishers?: number[] };

async function seedEdition(input: {
  title: string;
  identifiers: SeedIdentifier[];
  contributors?: number[];
}): Promise<{ uri: string; rkey: string; createdAt: string }> {
  const rkey = label();
  const uri = editionUri(rkey);
  const createdAt = '2020-01-02T03:04:05.000Z';
  await (pool as pg.Pool).query(
    `INSERT INTO editions (uri, rkey, title, created_at, indexed_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [uri, rkey, input.title, createdAt]
  );

  let identifierPosition = 0;
  for (const identifier of input.identifiers) {
    await (pool as pg.Pool).query(
      'INSERT INTO edition_identifiers (edition_uri, issuer, value) VALUES ($1, $2, $3)',
      [uri, identifier.issuer, identifier.value]
    );
    let position = 0;
    for (const publisherId of identifier.publishers ?? []) {
      position += 1;
      await (pool as pg.Pool).query(
        `INSERT INTO edition_identifier_publishers
           (edition_uri, issuer, value, publisher_id, position)
         VALUES ($1, $2, $3, $4, $5)`,
        [uri, identifier.issuer, identifier.value, publisherId, position]
      );
    }
    identifierPosition += 1;
  }
  assert.ok(identifierPosition > 0);

  let contributorPosition = 0;
  for (const contributorId of input.contributors ?? []) {
    contributorPosition += 1;
    await (pool as pg.Pool).query(
      `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
       VALUES ($1, $2, $3, 'A01')`,
      [uri, contributorId, contributorPosition]
    );
  }

  return { uri, rkey, createdAt };
}

/** Per-identifier publisher links of one edition, ordered by issuer then position. */
async function publisherLinks(
  uri: string
): Promise<Array<{ issuer: string; value: string; name: string; position: number }>> {
  const result = await (pool as pg.Pool).query(
    `SELECT ip.issuer, ip.value, p.name, ip.position
       FROM edition_identifier_publishers ip
       JOIN publishers p ON p.id = ip.publisher_id
      WHERE ip.edition_uri = $1
      ORDER BY identifier_shape_rank(ip.issuer), ip.issuer, ip.value, ip.position`,
    [uri]
  );
  return result.rows as Array<{
    issuer: string;
    value: string;
    name: string;
    position: number;
  }>;
}

before(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  try {
    await pool.query('SELECT 1');
    ready = true;
    await cleanup();
  } catch {
    ready = false;
  }
});

after(async () => {
  if (pool) {
    await cleanup().catch(() => {});
    await pool.end();
  }
});

test('union merges identifiers, credits and per-identifier publisher links', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const firstPublisher = await createPublisher(`${RUN} Alpha Press`);
  const secondPublisher = await createPublisher(`${RUN} Beta Press`);
  const thirdPublisher = await createPublisher(`${RUN} Gamma Press`);
  const firstContributor = await createContributor(`${RUN} Alpha Author`);
  const secondContributor = await createContributor(`${RUN} Beta Author`);

  const base = await seedEdition({
    title: 'Merge Alpha',
    identifiers: [{ issuer: 'isbn13', value: '9780000009001', publishers: [firstPublisher] }],
    contributors: [firstContributor]
  });
  const other = await seedEdition({
    title: 'Merge Beta',
    identifiers: [
      // The same ISBN as the base, credited to a different imprint.
      { issuer: 'isbn13', value: '9780000009001', publishers: [thirdPublisher] },
      { issuer: 'isbn10', value: '0000000002', publishers: [secondPublisher] }
    ],
    contributors: [secondContributor]
  });

  // A parked delete on the base must be rewritten to an edit by the merge.
  await db.query("UPDATE pds_outbox SET op = 'delete' WHERE uri = $1", [base.uri]);

  const result = await mergeEditions(db, {
    base: base.uri,
    others: [other.uri],
    contributors: { mode: 'union' },
    publishers: { mode: 'union' }
  });

  assert.deepEqual(result, {
    uri: base.uri,
    deleted: [other.uri],
    identifiers: 2,
    contributors: 2,
    publishers: 3
  });

  // Only the base survives, with its own identity intact.
  const editions = await db.query<{ uri: string; rkey: string; title: string; created_at: Date }>(
    'SELECT uri, rkey, title, created_at FROM editions WHERE uri = ANY($1::text[]) ORDER BY uri',
    [[base.uri, other.uri]]
  );
  assert.equal(editions.rowCount, 1);
  assert.equal(editions.rows[0]?.uri, base.uri);
  assert.equal(editions.rows[0]?.rkey, base.rkey);
  assert.equal(editions.rows[0]?.created_at.toISOString(), '2020-01-02T03:04:05.000Z');

  const identifiers = await db.query<{ issuer: string; value: string }>(
    'SELECT issuer, value FROM edition_identifiers WHERE edition_uri = $1 ORDER BY issuer',
    [base.uri]
  );
  assert.deepEqual(identifiers.rows, [
    { issuer: 'isbn10', value: '0000000002' },
    { issuer: 'isbn13', value: '9780000009001' }
  ]);

  // Base-first, position-renumbered, never overwritten.
  assert.deepEqual(
    (await publisherLinks(base.uri)).map((row) => [row.issuer, row.value, row.name, row.position]),
    [
      ['isbn13', '9780000009001', `${RUN} Alpha Press`, 1],
      ['isbn13', '9780000009001', `${RUN} Gamma Press`, 2],
      ['isbn10', '0000000002', `${RUN} Beta Press`, 1]
    ]
  );

  const credits = await db.query<{ contributor_id: string }>(
    'SELECT contributor_id FROM edition_contributors WHERE edition_uri = $1 ORDER BY position',
    [base.uri]
  );
  assert.deepEqual(
    credits.rows.map((row) => Number(row.contributor_id)),
    [firstContributor, secondContributor]
  );

  // The published record takes the head of the ordered list.
  const readModel = await db.query<{ publisher: { name: string }; publishers: unknown[] }>(
    'SELECT publisher, publishers FROM appview_book WHERE uri = $1',
    [base.uri]
  );
  assert.equal(readModel.rows[0]?.publisher.name, `${RUN} Alpha Press`);
  assert.deepEqual(
    (readModel.rows[0]?.publishers as Array<{ name: string }>).map((entry) => entry.name),
    [`${RUN} Alpha Press`, `${RUN} Gamma Press`, `${RUN} Beta Press`]
  );

  // Outbox: the absorbed edition is deleted, the base republished.
  const outbox = await db.query<{ uri: string; op: string }>(
    'SELECT uri, op FROM pds_outbox WHERE uri = ANY($1::text[]) ORDER BY uri',
    [[base.uri, other.uri]]
  );
  assert.deepEqual(
    outbox.rows.map((row) => [row.uri === base.uri ? 'base' : 'other', row.op]).sort(),
    [
      ['base', 'update'],
      ['other', 'delete']
    ]
  );
});

test('publisher source mode applies the chosen record set to every identifier', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const basePublisher = await createPublisher(`${RUN} Source Base Press`);
  const sourcePublisher = await createPublisher(`${RUN} Source One Press`);
  const sourceSecond = await createPublisher(`${RUN} Source Two Press`);

  const base = await seedEdition({
    title: 'Source Mode Base',
    identifiers: [{ issuer: 'isbn13', value: '9780000009003', publishers: [basePublisher] }]
  });
  const source = await seedEdition({
    title: 'Source Mode Source',
    identifiers: [
      { issuer: 'isbn10', value: '0000000004', publishers: [sourcePublisher, sourceSecond] }
    ]
  });

  const result = await mergeEditions(db, {
    base: base.uri,
    others: [source.uri],
    contributors: { mode: 'source', source: base.uri },
    publishers: { mode: 'source', source: source.uri }
  });

  assert.equal(result.publishers, 4);
  // Both identifiers of the base now carry the source's ordered set.
  assert.deepEqual(
    (await publisherLinks(base.uri)).map((row) => [row.issuer, row.value, row.name, row.position]),
    [
      ['isbn13', '9780000009003', `${RUN} Source One Press`, 1],
      ['isbn13', '9780000009003', `${RUN} Source Two Press`, 2],
      ['isbn10', '0000000004', `${RUN} Source One Press`, 1],
      ['isbn10', '0000000004', `${RUN} Source Two Press`, 2]
    ]
  );

  const readModel = await db.query<{ publisher: { name: string } }>(
    'SELECT publisher FROM appview_book WHERE uri = $1',
    [base.uri]
  );
  assert.equal(readModel.rows[0]?.publisher.name, `${RUN} Source One Press`);
});

test('a rejected merge writes nothing', async (t) => {
  const db = requiredPool(t);
  if (!db) return;

  const publisherId = await createPublisher(`${RUN} Reject Press`);
  const base = await seedEdition({
    title: 'Reject Base',
    identifiers: [{ issuer: 'isbn13', value: '9780000009005', publishers: [publisherId] }]
  });
  const other = await seedEdition({
    title: 'Reject Other',
    identifiers: [{ issuer: 'isbn10', value: '0000000006' }]
  });

  await assert.rejects(
    mergeEditions(db, {
      base: base.uri,
      others: [other.uri],
      sources: { title: 'at://did:plc:not-selected/community.lexicon.media.book.edition/x' },
      publishers: { mode: 'union' },
      contributors: { mode: 'union' }
    }),
    (error: unknown) =>
      error instanceof MergeError && error.status === 400 && /outside the selection/.test(error.message)
  );

  // Both editions and the base's own link are untouched.
  const editions = await db.query('SELECT uri FROM editions WHERE uri = ANY($1::text[])', [
    [base.uri, other.uri]
  ]);
  assert.equal(editions.rowCount, 2);
  assert.deepEqual(
    (await publisherLinks(base.uri)).map((row) => [row.value, row.name]),
    [['9780000009005', `${RUN} Reject Press`]]
  );

  // A merge of one edition, or of an unknown base, is rejected before writing.
  await assert.rejects(
    mergeEditions(db, { base: base.uri, others: [] }),
    (error: unknown) => error instanceof MergeError && error.status === 400
  );
  await assert.rejects(
    mergeEditions(db, { base: editionUri('missing-edition'), others: [other.uri] }),
    (error: unknown) => error instanceof MergeError && error.status === 404
  );
});
