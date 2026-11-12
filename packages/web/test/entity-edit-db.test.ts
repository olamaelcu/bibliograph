import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import {
  EntityEditError,
  updateAdminEntity
} from '../src/lib/server/admin/entity-edit.ts';
import { loadAdminEntity } from '../src/lib/server/admin/entity-read.ts';
import type {
  AdminContributorRecord,
  AdminPublisherRecord
} from '../src/lib/admin/types.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = `${process.pid}-${Date.now()}`;
const AUTHORITY = `did:plc:entityedit${process.pid}`;
const EDITION_COLLECTION = 'community.lexicon.media.book.edition';
const CONTRIBUTOR_COLLECTION = 'net.olamaelcu.livtet.biblio.contributor';
const PUBLISHER_COLLECTION = 'net.olamaelcu.livtet.biblio.publisher';

let pool: pg.Pool | undefined;
let ready = false;
let sequence = 0;

function label(): string {
  sequence += 1;
  return `entity${RUN.replace(/[^a-z0-9]/gi, '')}${sequence}`;
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

type EntitySeed = { id: number; atUri: string; createdAt: string };

async function createContributor(
  name: string,
  identifiers: unknown[] = []
): Promise<EntitySeed> {
  const result = await (pool as pg.Pool).query<{
    id: string;
    at_uri: string;
    created_at: Date;
  }>(
    `INSERT INTO contributors (name, identifiers, at_uri)
     VALUES ($1, $2::jsonb, 'at://' || $3 || '/' || $4 || '/' || editions_next_tid())
     RETURNING id, at_uri, created_at`,
    [name, JSON.stringify(identifiers), AUTHORITY, CONTRIBUTOR_COLLECTION]
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    id: Number(row.id),
    atUri: row.at_uri,
    createdAt: row.created_at.toISOString()
  };
}

async function createPublisher(
  name: string,
  identifiers: unknown[] = []
): Promise<EntitySeed> {
  const result = await (pool as pg.Pool).query<{
    id: string;
    at_uri: string;
    created_at: Date;
  }>(
    `INSERT INTO publishers (name, identifiers, at_uri)
     VALUES ($1, $2::jsonb, 'at://' || $3 || '/' || $4 || '/' || editions_next_tid())
     RETURNING id, at_uri, created_at`,
    [name, JSON.stringify(identifiers), AUTHORITY, PUBLISHER_COLLECTION]
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    id: Number(row.id),
    atUri: row.at_uri,
    createdAt: row.created_at.toISOString()
  };
}

async function seedEdition(contributorId: number, publisherId: number): Promise<string> {
  const rkey = label();
  const uri = `at://${AUTHORITY}/${EDITION_COLLECTION}/${rkey}`;
  await (pool as pg.Pool).query(
    `INSERT INTO editions (uri, rkey, title, created_at, indexed_at)
     VALUES ($1, $2, 'Entity trigger fixture', now(), now())`,
    [uri, rkey]
  );
  await (pool as pg.Pool).query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
     VALUES ($1, $2, 1, 'A01')`,
    [uri, contributorId]
  );
  await (pool as pg.Pool).query(
    `INSERT INTO edition_publishers (edition_uri, publisher_id, position)
     VALUES ($1, $2, 1)`,
    [uri, publisherId]
  );
  return uri;
}

async function clearOutbox(uris: string[]): Promise<void> {
  await (pool as pg.Pool).query('DELETE FROM pds_outbox WHERE uri = ANY($1::text[])', [uris]);
}

async function outbox(uri: string): Promise<{ collection: string; op: string } | null> {
  const result = await (pool as pg.Pool).query<{ collection: string; op: string }>(
    'SELECT collection, op FROM pds_outbox WHERE uri = $1',
    [uri]
  );
  return result.rows[0] ?? null;
}

function bodyFrom(record: AdminContributorRecord | AdminPublisherRecord, overrides: Record<string, unknown> = {}) {
  return {
    name: record.name,
    identifiers: record.identifiers,
    description: record.description,
    imageUrl: record.imageUrl,
    expectedRevision: record.revision,
    ...('nameInverted' in record
      ? { nameInverted: record.nameInverted, born: record.born, died: record.died }
      : { started: record.started, ended: record.ended }),
    ...overrides
  };
}

async function loadedContributor(db: pg.Pool, ref: string): Promise<AdminContributorRecord> {
  const record = await loadAdminEntity(db, 'contributor', ref);
  assert.ok(record, 'expected the contributor to load');
  return record;
}

async function loadedPublisher(db: pg.Pool, ref: string): Promise<AdminPublisherRecord> {
  const record = await loadAdminEntity(db, 'publisher', ref);
  assert.ok(record, 'expected the publisher to load');
  return record;
}

function isEntityError(status: number, code: string) {
  return (error: unknown) =>
    error instanceof EntityEditError && error.status === status && error.code === code;
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

test('loads a contributor by id and by a URL-encoded at-uri', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await createContributor(`${RUN} Loadable Person`, [
    { issuer: 'isni', value: '0000000111111111' }
  ]);
  await db.query(
    `UPDATE contributors
        SET name_inverted = 'Person, Loadable', description = 'A bio',
            image_url = 'https://example.org/p.jpg', born = '1920-10-08', died = '1986-02-11'
      WHERE id = $1`,
    [seeded.id]
  );

  const byId = await loadedContributor(db, String(seeded.id));
  assert.equal(byId.id, seeded.id);
  assert.equal(byId.atUri, seeded.atUri);
  assert.equal(byId.name, `${RUN} Loadable Person`);
  assert.equal(byId.nameInverted, 'Person, Loadable');
  assert.equal(byId.description, 'A bio');
  assert.equal(byId.imageUrl, 'https://example.org/p.jpg');
  assert.equal(byId.born, '1920-10-08');
  assert.equal(byId.died, '1986-02-11');
  assert.deepEqual(byId.identifiers, [{ issuer: 'isni', value: '0000000111111111' }]);
  assert.equal(byId.createdAt, seeded.createdAt);
  assert.match(byId.revision, /^[a-f0-9]{64}$/);

  const byUri = await loadedContributor(db, encodeURIComponent(seeded.atUri));
  assert.deepEqual(byUri, byId);

  const wrongKind = await loadAdminEntity(db, 'publisher', seeded.atUri);
  assert.equal(wrongKind, null);
});

test('loads a publisher by id and by a URL-encoded at-uri', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await createPublisher(`${RUN} Loadable Press`, [
    { issuer: 'viaf', value: '555' }
  ]);

  const byId = await loadedPublisher(db, String(seeded.id));
  assert.equal(byId.id, seeded.id);
  assert.equal(byId.atUri, seeded.atUri);
  assert.equal(byId.name, `${RUN} Loadable Press`);
  assert.equal(byId.started, null);
  assert.equal(byId.ended, null);
  assert.deepEqual(byId.identifiers, [{ issuer: 'viaf', value: '555' }]);
  assert.equal(byId.createdAt, seeded.createdAt);
  assert.match(byId.revision, /^[a-f0-9]{64}$/);

  const byUri = await loadedPublisher(db, encodeURIComponent(seeded.atUri));
  assert.deepEqual(byUri, byId);
});

test('updates a contributor atomically and queues its record and dependent editions', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const contributor = await createContributor(`${RUN} Atomic Person`, [
    { issuer: 'isni', value: '1' }
  ]);
  const publisher = await createPublisher(`${RUN} Atomic Press`);
  const editionUri = await seedEdition(contributor.id, publisher.id);
  await clearOutbox([editionUri, contributor.atUri]);

  const original = await loadedContributor(db, String(contributor.id));
  const saved = await updateAdminEntity(db, 'contributor', String(contributor.id), bodyFrom(
    original,
    {
      name: `${RUN} Renamed Person`,
      nameInverted: 'Person, Renamed',
      identifiers: [
        { issuer: 'isni', value: '2' },
        { issuer: 'viaf', value: '999' }
      ],
      description: 'Edited bio',
      imageUrl: 'https://example.org/renamed.jpg',
      born: '1924-02-29',
      died: '1990-12-31'
    }
  ));

  assert.equal(saved.id, original.id);
  assert.equal(saved.atUri, original.atUri);
  assert.equal(saved.createdAt, original.createdAt);
  assert.equal(saved.name, `${RUN} Renamed Person`);
  assert.equal(saved.nameInverted, 'Person, Renamed');
  assert.equal(saved.description, 'Edited bio');
  assert.equal(saved.imageUrl, 'https://example.org/renamed.jpg');
  assert.equal(saved.born, '1924-02-29');
  assert.equal(saved.died, '1990-12-31');
  assert.deepEqual(saved.identifiers, [
    { issuer: 'isni', value: '2' },
    { issuer: 'viaf', value: '999' }
  ]);
  assert.notEqual(saved.revision, original.revision);

  const row = await db.query<{ at_uri: string; created_at: Date; identifiers: unknown }>(
    'SELECT at_uri, created_at, identifiers FROM contributors WHERE id = $1',
    [contributor.id]
  );
  assert.equal(row.rows[0]?.at_uri, contributor.atUri);
  assert.equal(row.rows[0]?.created_at.toISOString(), contributor.createdAt);

  const entityQueued = await outbox(contributor.atUri);
  assert.equal(entityQueued?.collection, CONTRIBUTOR_COLLECTION);
  assert.equal(entityQueued?.op, 'update');
  const editionQueued = await outbox(editionUri);
  assert.equal(editionQueued?.collection, EDITION_COLLECTION);
  assert.equal(editionQueued?.op, 'update');

  const view = await db.query<{ contributors: Array<{ name: string }> }>(
    'SELECT contributors FROM appview_book WHERE uri = $1',
    [editionUri]
  );
  assert.equal(view.rows[0]?.contributors[0]?.name, `${RUN} Renamed Person`);
});

test('leaves identifiers and stored urls alone for a metadata-only edit', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const identifiers = [{ issuer: 'isni', value: '0000000222222222', url: 'https://example.org/isni' }];
  const contributor = await createContributor(`${RUN} Metadata Person`, identifiers);
  const publisher = await createPublisher(`${RUN} Metadata Press`);
  const editionUri = await seedEdition(contributor.id, publisher.id);
  await clearOutbox([editionUri, contributor.atUri]);

  const original = await loadedContributor(db, String(contributor.id));
  // The editor read path shows pairs; the stored `url` is not part of the form.
  assert.deepEqual(original.identifiers, [{ issuer: 'isni', value: '0000000222222222' }]);

  const saved = await updateAdminEntity(
    db,
    'contributor',
    String(contributor.id),
    bodyFrom(original, { description: 'Only the bio changed' })
  );
  assert.equal(saved.description, 'Only the bio changed');
  assert.notEqual(saved.revision, original.revision);

  const row = await db.query<{ identifiers: unknown }>(
    'SELECT identifiers FROM contributors WHERE id = $1',
    [contributor.id]
  );
  assert.deepEqual(row.rows[0]?.identifiers, identifiers);

  assert.ok(await outbox(contributor.atUri), 'the entity trigger must queue the record');
  assert.equal(await outbox(editionUri), null, 'a metadata-only edit must not queue editions');
});

test('updates a publisher and queues its record and dependent editions', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const contributor = await createContributor(`${RUN} Publisher Author`);
  const publisher = await createPublisher(`${RUN} Original Press`);
  const editionUri = await seedEdition(contributor.id, publisher.id);
  await clearOutbox([editionUri, publisher.atUri]);

  const original = await loadedPublisher(db, String(publisher.id));
  const saved = await updateAdminEntity(db, 'publisher', String(publisher.id), bodyFrom(
    original,
    {
      name: `${RUN} Renamed Press`,
      identifiers: [{ issuer: 'viaf', value: '777' }],
      description: 'A press bio',
      imageUrl: 'http://example.org/press.png',
      started: '1972-01-01',
      ended: '1998-12-31'
    }
  ));

  assert.equal(saved.id, original.id);
  assert.equal(saved.atUri, original.atUri);
  assert.equal(saved.createdAt, original.createdAt);
  assert.equal(saved.name, `${RUN} Renamed Press`);
  assert.equal(saved.started, '1972-01-01');
  assert.equal(saved.ended, '1998-12-31');
  assert.deepEqual(saved.identifiers, [{ issuer: 'viaf', value: '777' }]);

  assert.equal((await outbox(publisher.atUri))?.collection, PUBLISHER_COLLECTION);
  assert.equal((await outbox(editionUri))?.collection, EDITION_COLLECTION);

  const view = await db.query<{ publishers: Array<{ name: string }> }>(
    'SELECT publishers FROM appview_book WHERE uri = $1',
    [editionUri]
  );
  assert.equal(view.rows[0]?.publishers[0]?.name, `${RUN} Renamed Press`);
});

test('keeps stored identifier urls for pairs retained during a replacement', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const contributor = await createContributor(`${RUN} Url Person`, [
    { issuer: 'isni', value: 'keep', url: 'https://example.org/isni/keep' },
    { issuer: 'viaf', value: 'drop' }
  ]);
  const original = await loadedContributor(db, String(contributor.id));

  await updateAdminEntity(db, 'contributor', String(contributor.id), bodyFrom(original, {
    identifiers: [
      { issuer: 'isni', value: 'keep' },
      { issuer: 'oclc', value: 'new' }
    ]
  }));

  const row = await db.query<{ identifiers: unknown }>(
    'SELECT identifiers FROM contributors WHERE id = $1',
    [contributor.id]
  );
  assert.deepEqual(row.rows[0]?.identifiers, [
    { issuer: 'isni', value: 'keep', url: 'https://example.org/isni/keep' },
    { issuer: 'oclc', value: 'new' }
  ]);
});

test('rejects a stale revision with 409 and leaves the row unchanged', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const contributor = await createContributor(`${RUN} Revision Person`);
  const original = await loadedContributor(db, String(contributor.id));

  const saved = await updateAdminEntity(
    db,
    'contributor',
    String(contributor.id),
    bodyFrom(original, { name: `${RUN} Revision Person Two` })
  );
  assert.equal(saved.name, `${RUN} Revision Person Two`);

  await assert.rejects(
    updateAdminEntity(
      db,
      'contributor',
      String(contributor.id),
      bodyFrom(original, { name: `${RUN} Revision Person Three` })
    ),
    isEntityError(409, 'EntityChanged')
  );

  const row = await db.query<{ name: string }>('SELECT name FROM contributors WHERE id = $1', [
    contributor.id
  ]);
  assert.equal(row.rows[0]?.name, `${RUN} Revision Person Two`);
});

test('rejects an unknown id or at-uri with 404', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await createContributor(`${RUN} Known Person`);
  const body = bodyFrom(await loadedContributor(db, String(seeded.id)));

  await assert.rejects(
    updateAdminEntity(db, 'contributor', '900000000000000', body),
    isEntityError(404, 'NotFound')
  );
  await assert.rejects(
    updateAdminEntity(
      db,
      'contributor',
      `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/missing${sequence}`,
      body
    ),
    isEntityError(404, 'NotFound')
  );
  assert.equal(
    await loadAdminEntity(db, 'contributor', `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/missing`),
    null
  );
});

test('maps the unique identity conflict to 409 without writing', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const first = await createContributor(`${RUN} Conflict One`, [
    { issuer: 'isni', value: '1' }
  ]);
  const secondName = `${RUN} Conflict Two`;
  const second = await createContributor(secondName, [{ issuer: 'isni', value: '2' }]);
  const current = await loadedContributor(db, String(second.id));

  await assert.rejects(
    updateAdminEntity(db, 'contributor', String(second.id), bodyFrom(current, {
      name: `${RUN} conflict one`,
      identifiers: [{ issuer: 'isni', value: '1' }]
    })),
    isEntityError(409, 'DuplicateEntity')
  );

  const row = await db.query<{ name: string; identifiers: unknown }>(
    'SELECT name, identifiers FROM contributors WHERE id = $1',
    [second.id]
  );
  assert.equal(row.rows[0]?.name, secondName);
  assert.deepEqual(row.rows[0]?.identifiers, [{ issuer: 'isni', value: '2' }]);
  const untouched = await db.query<{ name: string; identifiers: unknown }>(
    'SELECT name, identifiers FROM contributors WHERE id = $1',
    [first.id]
  );
  assert.equal(untouched.rows[0]?.name, `${RUN} Conflict One`);
});

test('rejects invalid bodies before opening a transaction', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const contributor = await createContributor(`${RUN} Strict Person`);
  const original = await loadedContributor(db, String(contributor.id));

  for (const body of [
    { name: '   ' },
    { name: 'Valid', born: '2023-02-29' },
    { name: 'Valid', died: '1986-2-11' },
    { name: 'Valid', imageUrl: 'javascript:alert(1)' },
    { name: 'Valid', imageUrl: '/relative.jpg' },
    { name: 'Valid', identifiers: [{ issuer: 'isni', value: ' ' }] }
  ]) {
    await assert.rejects(
      updateAdminEntity(db, 'contributor', String(contributor.id), body),
      (error: unknown) => error instanceof EntityEditError && error.status === 400
    );
  }

  const row = await db.query<{ name: string; identifiers: unknown }>(
    'SELECT name, identifiers FROM contributors WHERE id = $1',
    [contributor.id]
  );
  assert.equal(row.rows[0]?.name, original.name);
  assert.deepEqual(row.rows[0]?.identifiers, []);
});

test('accepts a save with no expectedRevision and a no-op save', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const contributor = await createContributor(`${RUN} Noop Person`);
  const original = await loadedContributor(db, String(contributor.id));

  const noRevision = await updateAdminEntity(
    db,
    'contributor',
    String(contributor.id),
    bodyFrom(original, { expectedRevision: null, description: 'No token' })
  );
  assert.equal(noRevision.description, 'No token');

  const noop = await updateAdminEntity(
    db,
    'contributor',
    String(contributor.id),
    bodyFrom(noRevision)
  );
  assert.equal(noop.revision, noRevision.revision);
  assert.equal(noop.description, 'No token');
});
