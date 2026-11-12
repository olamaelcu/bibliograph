import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import {
  EditionEditError,
  loadEditionForEdit,
  updateAdminEdition
} from '../src/lib/server/admin/edition-edit.ts';
import type { AdminEdition } from '../src/lib/admin/types.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = `${process.pid}-${Date.now()}`;
const AUTHORITY = `did:plc:editionedit${process.pid}`;
const EDITION_COLLECTION = 'community.lexicon.media.book.edition';
const CONTRIBUTOR_COLLECTION = 'net.olamaelcu.livtet.biblio.contributor';
const PUBLISHER_COLLECTION = 'net.olamaelcu.livtet.biblio.publisher';

let pool: pg.Pool | undefined;
let ready = false;
let sequence = 0;

function label(): string {
  sequence += 1;
  return `edit${RUN.replace(/[^a-z0-9]/gi, '')}${sequence}`;
}

function requiredPool(t: { skip: (message?: string) => void }): pg.Pool | null {
  if (!ready || !pool) {
    t.skip('DATABASE_URL is not reachable; skipping catalog integration tests');
    return null;
  }
  return pool;
}

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

async function seedEdition(
  title = 'Original title'
): Promise<{ uri: string; rkey: string; contributorId: number; publisherId: number }> {
  const rkey = label();
  const uri = `at://${AUTHORITY}/${EDITION_COLLECTION}/${rkey}`;
  await (pool as pg.Pool).query(
    `INSERT INTO editions (uri, rkey, title, created_at, indexed_at)
     VALUES ($1, $2, $3, '2020-01-02T03:04:05.000Z', '2020-01-02T03:04:05.000Z')`,
    [uri, rkey, title]
  );
  await (pool as pg.Pool).query(
    `INSERT INTO edition_identifiers (edition_uri, issuer, value)
     VALUES ($1, 'isbn13', '9780000000001')`,
    [uri]
  );
  const contributorId = await createContributor(`${RUN} Author ${rkey}`);
  const publisherId = await createPublisher(`${RUN} Press ${rkey}`);
  await (pool as pg.Pool).query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role, ref)
     VALUES ($1, $2, 1, 'A01', NULL)`,
    [uri, contributorId]
  );
  await (pool as pg.Pool).query(
    `INSERT INTO edition_publishers (edition_uri, publisher_id, position)
     VALUES ($1, $2, 1)`,
    [uri, publisherId]
  );
  return { uri, rkey, contributorId, publisherId };
}

function bodyFrom(edition: AdminEdition, overrides: Record<string, unknown> = {}) {
  return {
    title: edition.title,
    subtitle: edition.subtitle,
    language: edition.language,
    publishedDate: edition.publishedDate,
    format: edition.format,
    pages: edition.pages,
    durationSeconds: edition.durationSeconds,
    chapters: edition.chapters,
    series: edition.series,
    bookEdition: edition.bookEdition,
    description: edition.description,
    coverUrl: edition.coverUrl,
    identifiers: edition.identifiers,
    contributors: edition.contributors.map((contributor) => ({
      id: contributor.id,
      role: contributor.role,
      ref: contributor.ref
    })),
    publishers: edition.publishers.map((publisher) => ({ id: publisher.id })),
    expectedRevision: edition.revision,
    ...overrides
  };
}

async function loaded(ref: string): Promise<AdminEdition> {
  const edition = await loadEditionForEdit(pool as pg.Pool, ref);
  assert.ok(edition, 'expected the seeded edition to load');
  return edition;
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

test('loads an edition by rkey and by a URL-encoded at-uri', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Loadable');

  const byRkey = await loadEditionForEdit(db, seeded.rkey);
  assert.ok(byRkey);
  assert.equal(byRkey.uri, seeded.uri);
  assert.equal(byRkey.title, 'Loadable');
  assert.equal(byRkey.contributors.length, 1);
  assert.equal(byRkey.publishers.length, 1);
  assert.equal(byRkey.identifiers[0]?.value, '9780000000001');
  assert.match(byRkey.revision, /^[a-f0-9]{64}$/);

  const byUri = await loadEditionForEdit(db, encodeURIComponent(seeded.uri));
  assert.ok(byUri);
  assert.equal(byUri.uri, seeded.uri);
});

test('updates scalars, identifiers, contributor order/roles and publisher order atomically', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition();
  const original = await loaded(seeded.rkey);
  const secondContributor = await createContributor(`${RUN} Second Author ${seeded.rkey}`);
  const secondPublisher = await createPublisher(`${RUN} Second Press ${seeded.rkey}`);
  const ref = `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/override${sequence}`;

  const saved = await updateAdminEdition(db, seeded.rkey, bodyFrom(original, {
    title: 'Edited title',
    subtitle: 'An edited subtitle',
    language: 'en',
    publishedDate: '2024-02-29',
    format: 'ebook',
    pages: 320,
    durationSeconds: 3600,
    chapters: 12,
    series: { name: 'Saga', position: '2', display: 'Vol. II' },
    bookEdition: '2nd revised',
    description: 'Edited description',
    coverUrl: 'https://example.org/edited.jpg',
    identifiers: [
      { issuer: 'isbn13', value: '9780000000002' },
      { issuer: 'oclc', value: '12345' }
    ],
    contributors: [
      { id: secondContributor, role: 'B01', ref },
      { id: seeded.contributorId, role: 'A01', ref: null }
    ],
    publishers: [{ id: secondPublisher }, { id: seeded.publisherId }]
  }));

  assert.equal(saved.uri, original.uri);
  assert.equal(saved.rkey, original.rkey);
  assert.equal(saved.createdAt, original.createdAt);
  assert.equal(saved.title, 'Edited title');
  assert.equal(saved.pages, 320);
  assert.deepEqual(saved.series, { name: 'Saga', position: '2', display: 'Vol. II' });
  assert.deepEqual(saved.identifiers.map((identifier) => identifier.value).sort(), [
    '12345',
    '9780000000002'
  ]);
  assert.equal(saved.contributors[0]?.id, secondContributor);
  assert.equal(saved.contributors[0]?.role, 'B01');
  assert.equal(saved.contributors[0]?.ref, ref);
  assert.equal(saved.contributors[1]?.id, seeded.contributorId);
  assert.deepEqual(saved.publishers.map((publisher) => publisher.id), [
    secondPublisher,
    seeded.publisherId
  ]);

  const row = await db.query<{ title: string; created_at: Date; rkey: string }>(
    'SELECT title, created_at, rkey FROM editions WHERE uri = $1',
    [seeded.uri]
  );
  assert.equal(row.rows[0]?.title, 'Edited title');
  assert.equal(row.rows[0]?.rkey, seeded.rkey);
  assert.equal(row.rows[0]?.created_at.toISOString(), '2020-01-02T03:04:05.000Z');

  const identifiers = await db.query<{ issuer: string; value: string }>(
    'SELECT issuer, value FROM edition_identifiers WHERE edition_uri = $1 ORDER BY issuer, value',
    [seeded.uri]
  );
  assert.deepEqual(identifiers.rows, [
    { issuer: 'isbn13', value: '9780000000002' },
    { issuer: 'oclc', value: '12345' }
  ]);

  const publisher = await db.query<{ publisher: { name: string } }>(
    'SELECT publisher FROM appview_book WHERE uri = $1',
    [seeded.uri]
  );
  assert.equal(publisher.rows[0]?.publisher.name, `${RUN} Second Press ${seeded.rkey}`);

  const queued = await db.query<{ op: string }>(
    'SELECT op FROM pds_outbox WHERE uri = $1',
    [seeded.uri]
  );
  assert.ok(queued.rows[0], 'the edition trigger must queue the edition');
});

test('creates a contributor from name and identifiers, then dedupes it', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition();
  const original = await loaded(seeded.rkey);
  const name = `${RUN} Deduped Person ${seeded.rkey}`;
  const identifiers = [{ issuer: 'isni', value: '0000000123456789' }];

  const first = await updateAdminEdition(db, seeded.rkey, bodyFrom(original, {
    contributors: [
      { name, identifiers, role: 'B01', ref: `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/edge` },
      { id: seeded.contributorId, role: 'A01', ref: null }
    ]
  }));
  const created = first.contributors.find((contributor) => contributor.name === name);
  assert.ok(created);
  assert.ok(created.id > 0);

  const second = await updateAdminEdition(db, seeded.rkey, bodyFrom(first, {
    contributors: [
      { name, identifiers, role: 'B01', ref: `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/edge` },
      { id: seeded.contributorId, role: 'A01', ref: null }
    ]
  }));

  const matching = await db.query<{ id: string; at_uri: string | null }>(
    'SELECT id, at_uri FROM contributors WHERE lower(name) = lower($1) AND identifiers = $2::jsonb',
    [name, JSON.stringify(identifiers)]
  );
  assert.equal(matching.rowCount, 1);
  assert.equal(Number(matching.rows[0]?.id), created.id);
  assert.match(matching.rows[0]?.at_uri ?? '', new RegExp(`^at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/`));
  assert.equal(second.contributors.length, 2);
  assert.equal(second.contributors[0]?.id, created.id);
});

test('removes a credit without deleting the shared contributor or publisher', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition();
  const original = await loaded(seeded.rkey);
  const secondContributor = await createContributor(`${RUN} Unlinked Author ${seeded.rkey}`);
  const secondPublisher = await createPublisher(`${RUN} Unlinked Press ${seeded.rkey}`);

  await updateAdminEdition(db, seeded.rkey, bodyFrom(original, {
    contributors: [
      { id: seeded.contributorId, role: 'A01', ref: null },
      { id: secondContributor, role: 'B01', ref: null }
    ],
    publishers: [{ id: seeded.publisherId }, { id: secondPublisher }]
  }));

  const mid = await loaded(seeded.rkey);
  const saved = await updateAdminEdition(db, seeded.rkey, bodyFrom(mid, {
    contributors: [{ id: seeded.contributorId, role: 'A01', ref: null }],
    publishers: [{ id: seeded.publisherId }]
  }));

  assert.equal(saved.contributors.length, 1);
  assert.equal(saved.publishers.length, 1);
  const contributor = await db.query('SELECT id FROM contributors WHERE id = $1', [
    secondContributor
  ]);
  const publisher = await db.query('SELECT id FROM publishers WHERE id = $1', [secondPublisher]);
  assert.equal(contributor.rowCount, 1);
  assert.equal(publisher.rowCount, 1);
});

test('rejects an unknown contributor id and rolls back the scalar change', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Unchanged title');
  const original = await loaded(seeded.rkey);

  await assert.rejects(
    updateAdminEdition(db, seeded.rkey, bodyFrom(original, {
      title: 'Must roll back',
      contributors: [{ id: 9_000_000_000_000, role: 'A01', ref: null }]
    })),
    (error: unknown) =>
      error instanceof EditionEditError &&
      error.status === 400 &&
      error.code === 'UnknownContributor'
  );

  const row = await db.query<{ title: string }>('SELECT title FROM editions WHERE uri = $1', [
    seeded.uri
  ]);
  assert.equal(row.rows[0]?.title, 'Unchanged title');
});

test('rejects a stale revision with 409', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Revision A');
  const original = await loaded(seeded.rkey);

  const saved = await updateAdminEdition(db, seeded.rkey, bodyFrom(original, {
    title: 'Revision B'
  }));
  assert.equal(saved.title, 'Revision B');

  await assert.rejects(
    updateAdminEdition(db, seeded.rkey, bodyFrom(original, { title: 'Revision C' })),
    (error: unknown) =>
      error instanceof EditionEditError && error.status === 409 && error.code === 'EditionChanged'
  );
  const row = await db.query<{ title: string }>('SELECT title FROM editions WHERE uri = $1', [
    seeded.uri
  ]);
  assert.equal(row.rows[0]?.title, 'Revision B');
});

test('accepts the current revision with no changes', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Stable revision');
  const first = await loaded(seeded.rkey);
  const second = await loaded(seeded.rkey);
  assert.equal(first.revision, second.revision);

  const saved = await updateAdminEdition(db, seeded.rkey, bodyFrom(second));
  assert.equal(saved.title, 'Stable revision');
  assert.equal(saved.revision, second.revision);
});

test('rejects invalid bodies before opening a transaction', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition('Valid title');
  const original = await loaded(seeded.rkey);

  await assert.rejects(
    updateAdminEdition(db, seeded.rkey, bodyFrom(original, { title: '   ' })),
    (error: unknown) =>
      error instanceof EditionEditError && error.status === 400 && error.code === 'InvalidEdition'
  );
  await assert.rejects(
    updateAdminEdition(db, seeded.rkey, bodyFrom(original, {
      coverUrl: 'javascript:alert(1)'
    })),
    (error: unknown) => error instanceof EditionEditError && error.status === 400
  );
});

test('returns 404 for an unknown edition', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  assert.equal(await loadEditionForEdit(db, `missing${RUN}`), null);
  await assert.rejects(
    updateAdminEdition(db, `missing${RUN}`, {
      title: 'x',
      identifiers: [{ issuer: 'isbn13', value: '1' }],
      contributors: [{ name: 'A' }]
    }),
    (error: unknown) => error instanceof EditionEditError && error.status === 404
  );
});

test('queues new contributor and publisher entity rows through triggers', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await seedEdition();
  const original = await loaded(seeded.rkey);
  const name = `${RUN} Outbox Person ${seeded.rkey}`;
  const publisherName = `${RUN} Outbox Press ${seeded.rkey}`;

  const saved = await updateAdminEdition(db, seeded.rkey, bodyFrom(original, {
    contributors: [
      { id: seeded.contributorId, role: 'A01', ref: null },
      { name, identifiers: [{ issuer: 'isni', value: '999' }], role: 'B01', ref: null }
    ],
    publishers: [{ id: seeded.publisherId }, { name: publisherName, identifiers: [] }]
  }));

  const contributor = saved.contributors.find((credit) => credit.name === name);
  const publisher = saved.publishers.find((entry) => entry.name === publisherName);
  assert.ok(contributor);
  assert.ok(publisher);

  const contributorOutbox = await db.query<{ collection: string; op: string }>(
    'SELECT collection, op FROM pds_outbox WHERE uri LIKE $1',
    [`at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/%`]
  );
  assert.ok(
    contributorOutbox.rows.some(
      (row) => row.collection === CONTRIBUTOR_COLLECTION && ['create', 'update'].includes(row.op)
    )
  );
  const publisherOutbox = await db.query<{ collection: string; op: string }>(
    'SELECT collection, op FROM pds_outbox WHERE uri LIKE $1',
    [`at://${AUTHORITY}/${PUBLISHER_COLLECTION}/%`]
  );
  assert.ok(
    publisherOutbox.rows.some(
      (row) => row.collection === PUBLISHER_COLLECTION && ['create', 'update'].includes(row.op)
    )
  );
  const editionOutbox = await db.query<{ op: string }>(
    `SELECT op FROM pds_outbox
      WHERE uri = $1 AND collection = 'community.lexicon.media.book.edition'`,
    [seeded.uri]
  );
  assert.ok(editionOutbox.rows[0], 'the edition row must be queued by the catalog trigger');
});
