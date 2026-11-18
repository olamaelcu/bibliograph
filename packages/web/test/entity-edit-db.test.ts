import { expect, test, afterAll, beforeAll } from 'vitest';

import pg from 'pg';

import {
  EntityEditError,
  deleteAdminEntity,
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
  await pool.query('DELETE FROM books WHERE uri LIKE $1', [prefix]);
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
  expect(row).toBeTruthy();
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
  expect(row).toBeTruthy();
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
    `INSERT INTO books (uri, rkey, title, created_at, indexed_at)
     VALUES ($1, $2, 'Entity trigger fixture', now(), now())`,
    [uri, rkey]
  );
  await (pool as pg.Pool).query(
    `INSERT INTO edition_identifiers (edition_uri, issuer, value)
     VALUES ($1, 'isbn13', '9780000000001')`,
    [uri]
  );
  await (pool as pg.Pool).query(
    `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role)
     VALUES ($1, $2, 1, 'A01')`,
    [uri, contributorId]
  );
  await (pool as pg.Pool).query(
    `INSERT INTO edition_identifier_publishers
       (edition_uri, issuer, value, publisher_id, position)
     VALUES ($1, 'isbn13', '9780000000001', $2, 1)`,
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
  expect(record, 'expected the contributor to load').toBeTruthy();
  return record;
}

async function loadedPublisher(db: pg.Pool, ref: string): Promise<AdminPublisherRecord> {
  const record = await loadAdminEntity(db, 'publisher', ref);
  expect(record, 'expected the publisher to load').toBeTruthy();
  return record;
}

function isEntityError(status: number, code: string) {
  return (error: unknown) =>
    error instanceof EntityEditError && error.status === status && error.code === code;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  try {
    await pool.query('SELECT 1');
    ready = true;
    await cleanup();
  } catch {
    ready = false;
  }
});

afterAll(async () => {
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
  expect(byId.id).toBe(seeded.id);
  expect(byId.atUri).toBe(seeded.atUri);
  expect(byId.name).toBe(`${RUN} Loadable Person`);
  expect(byId.nameInverted).toBe('Person, Loadable');
  expect(byId.description).toBe('A bio');
  expect(byId.imageUrl).toBe('https://example.org/p.jpg');
  expect(byId.born).toBe('1920-10-08');
  expect(byId.died).toBe('1986-02-11');
  expect(byId.identifiers).toEqual([{ issuer: 'isni', value: '0000000111111111' }]);
  expect(byId.createdAt).toBe(seeded.createdAt);
  expect(byId.revision).toMatch(/^[a-f0-9]{64}$/);

  const byUri = await loadedContributor(db, encodeURIComponent(seeded.atUri));
  expect(byUri).toEqual(byId);

  const wrongKind = await loadAdminEntity(db, 'publisher', seeded.atUri);
  expect(wrongKind).toBe(null);
});

test('loads a publisher by id and by a URL-encoded at-uri', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await createPublisher(`${RUN} Loadable Press`, [
    { issuer: 'viaf', value: '555' }
  ]);

  const byId = await loadedPublisher(db, String(seeded.id));
  expect(byId.id).toBe(seeded.id);
  expect(byId.atUri).toBe(seeded.atUri);
  expect(byId.name).toBe(`${RUN} Loadable Press`);
  expect(byId.started).toBe(null);
  expect(byId.ended).toBe(null);
  expect(byId.identifiers).toEqual([{ issuer: 'viaf', value: '555' }]);
  expect(byId.createdAt).toBe(seeded.createdAt);
  expect(byId.revision).toMatch(/^[a-f0-9]{64}$/);

  const byUri = await loadedPublisher(db, encodeURIComponent(seeded.atUri));
  expect(byUri).toEqual(byId);
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

  expect(saved.id).toBe(original.id);
  expect(saved.atUri).toBe(original.atUri);
  expect(saved.createdAt).toBe(original.createdAt);
  expect(saved.name).toBe(`${RUN} Renamed Person`);
  expect(saved.nameInverted).toBe('Person, Renamed');
  expect(saved.description).toBe('Edited bio');
  expect(saved.imageUrl).toBe('https://example.org/renamed.jpg');
  expect(saved.born).toBe('1924-02-29');
  expect(saved.died).toBe('1990-12-31');
  expect(saved.identifiers).toEqual([
    { issuer: 'isni', value: '2' },
    { issuer: 'viaf', value: '999' }
  ]);
  expect(saved.revision).not.toBe(original.revision);

  const row = await db.query<{ at_uri: string; created_at: Date; identifiers: unknown }>(
    'SELECT at_uri, created_at, identifiers FROM contributors WHERE id = $1',
    [contributor.id]
  );
  expect(row.rows[0]?.at_uri).toBe(contributor.atUri);
  expect(row.rows[0]?.created_at.toISOString()).toBe(contributor.createdAt);

  const entityQueued = await outbox(contributor.atUri);
  expect(entityQueued?.collection).toBe(CONTRIBUTOR_COLLECTION);
  expect(entityQueued?.op).toBe('update');
  const editionQueued = await outbox(editionUri);
  expect(editionQueued?.collection).toBe(EDITION_COLLECTION);
  expect(editionQueued?.op).toBe('update');

  const view = await db.query<{ contributors: Array<{ name: string }> }>(
    'SELECT contributors FROM appview_book WHERE uri = $1',
    [editionUri]
  );
  expect(view.rows[0]?.contributors[0]?.name).toBe(`${RUN} Renamed Person`);
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
  expect(original.identifiers).toEqual([{ issuer: 'isni', value: '0000000222222222' }]);

  const saved = await updateAdminEntity(
    db,
    'contributor',
    String(contributor.id),
    bodyFrom(original, { description: 'Only the bio changed' })
  );
  expect(saved.description).toBe('Only the bio changed');
  expect(saved.revision).not.toBe(original.revision);

  const row = await db.query<{ identifiers: unknown }>(
    'SELECT identifiers FROM contributors WHERE id = $1',
    [contributor.id]
  );
  expect(row.rows[0]?.identifiers).toEqual(identifiers);

  expect(await outbox(contributor.atUri), 'the entity trigger must queue the record').toBeTruthy();
  expect(await outbox(editionUri), 'a metadata-only edit must not queue editions').toBe(null);
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

  expect(saved.id).toBe(original.id);
  expect(saved.atUri).toBe(original.atUri);
  expect(saved.createdAt).toBe(original.createdAt);
  expect(saved.name).toBe(`${RUN} Renamed Press`);
  expect(saved.started).toBe('1972-01-01');
  expect(saved.ended).toBe('1998-12-31');
  expect(saved.identifiers).toEqual([{ issuer: 'viaf', value: '777' }]);

  expect((await outbox(publisher.atUri))?.collection).toBe(PUBLISHER_COLLECTION);
  expect((await outbox(editionUri))?.collection).toBe(EDITION_COLLECTION);

  const view = await db.query<{ publishers: Array<{ name: string }> }>(
    'SELECT publishers FROM appview_book WHERE uri = $1',
    [editionUri]
  );
  expect(view.rows[0]?.publishers[0]?.name).toBe(`${RUN} Renamed Press`);
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
  expect(row.rows[0]?.identifiers).toEqual([
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
  expect(saved.name).toBe(`${RUN} Revision Person Two`);

  await expect(updateAdminEntity(
      db,
      'contributor',
      String(contributor.id),
      bodyFrom(original, { name: `${RUN} Revision Person Three` })
    )).rejects.toSatisfy(isEntityError(409, 'EntityChanged'));

  const row = await db.query<{ name: string }>('SELECT name FROM contributors WHERE id = $1', [
    contributor.id
  ]);
  expect(row.rows[0]?.name).toBe(`${RUN} Revision Person Two`);
});

test('rejects an unknown id or at-uri with 404', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await createContributor(`${RUN} Known Person`);
  const body = bodyFrom(await loadedContributor(db, String(seeded.id)));

  await expect(updateAdminEntity(db, 'contributor', '900000000000000', body)).rejects.toSatisfy(isEntityError(404, 'NotFound'));
  await expect(updateAdminEntity(
      db,
      'contributor',
      `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/missing${sequence}`,
      body
    )).rejects.toSatisfy(isEntityError(404, 'NotFound'));
  expect(await loadAdminEntity(db, 'contributor', `at://${AUTHORITY}/${CONTRIBUTOR_COLLECTION}/missing`)).toBe(null);
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

  await expect(updateAdminEntity(db, 'contributor', String(second.id), bodyFrom(current, {
      name: `${RUN} conflict one`,
      identifiers: [{ issuer: 'isni', value: '1' }]
    }))).rejects.toSatisfy(isEntityError(409, 'DuplicateEntity'));

  const row = await db.query<{ name: string; identifiers: unknown }>(
    'SELECT name, identifiers FROM contributors WHERE id = $1',
    [second.id]
  );
  expect(row.rows[0]?.name).toBe(secondName);
  expect(row.rows[0]?.identifiers).toEqual([{ issuer: 'isni', value: '2' }]);
  const untouched = await db.query<{ name: string; identifiers: unknown }>(
    'SELECT name, identifiers FROM contributors WHERE id = $1',
    [first.id]
  );
  expect(untouched.rows[0]?.name).toBe(`${RUN} Conflict One`);
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
    await expect(updateAdminEntity(db, 'contributor', String(contributor.id), body)).rejects.toSatisfy((error: unknown) => error instanceof EntityEditError && error.status === 400);
  }

  const row = await db.query<{ name: string; identifiers: unknown }>(
    'SELECT name, identifiers FROM contributors WHERE id = $1',
    [contributor.id]
  );
  expect(row.rows[0]?.name).toBe(original.name);
  expect(row.rows[0]?.identifiers).toEqual([]);
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
  expect(noRevision.description).toBe('No token');

  const noop = await updateAdminEntity(
    db,
    'contributor',
    String(contributor.id),
    bodyFrom(noRevision)
  );
  expect(noop.revision).toBe(noRevision.revision);
  expect(noop.description).toBe('No token');
});

test('deletes an uncredited contributor and queues its record deletion', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await createContributor(`${RUN} Deletable Person`);
  const record = await loadedContributor(db, String(seeded.id));
  await clearOutbox([seeded.atUri]);

  const deleted = await deleteAdminEntity(
    db,
    'contributor',
    String(seeded.id),
    record.revision
  );

  expect(deleted).toBe(seeded.id);
  expect(await loadAdminEntity(db, 'contributor', String(seeded.id))).toBe(null);
  expect(await outbox(seeded.atUri)).toEqual({
    collection: CONTRIBUTOR_COLLECTION,
    op: 'delete'
  });
});

test('refuses to delete a contributor still credited on an edition', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const contributor = await createContributor(`${RUN} Credited Person`);
  const publisher = await createPublisher(`${RUN} Credited Press`);
  const editionUri = await seedEdition(contributor.id, publisher.id);
  const record = await loadedContributor(db, String(contributor.id));

  await expect(() => deleteAdminEntity(db, 'contributor', String(contributor.id), record.revision)).rejects.toSatisfy((error: unknown) => {
      expect(error instanceof EntityEditError).toBeTruthy();
      expect(error.status).toBe(409);
      expect(error.code).toBe('EntityInUse');
      expect(error.message).toMatch(/credited on 1 edition/);
      expect(error.message).toMatch(/merge it into another contributor/);
      return true;
    });

  expect((await loadAdminEntity(db, 'contributor', String(contributor.id))) !== null, 'a refused delete leaves the contributor and its credit in place').toBeTruthy();
  const credits = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM edition_contributors WHERE edition_uri = $1',
    [editionUri]
  );
  expect(credits.rows[0]?.n).toBe(1);
});

test('refuses to delete a contributor that changed since it was loaded', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await createContributor(`${RUN} Stale Person`);
  const record = await loadedContributor(db, String(seeded.id));
  await updateAdminEntity(db, 'contributor', String(seeded.id), {
    ...bodyFrom(record),
    name: `${RUN} Renamed Person`
  });

  await expect(() => deleteAdminEntity(db, 'contributor', String(seeded.id), record.revision)).rejects.toSatisfy((error: unknown) =>
      error instanceof EntityEditError && error.status === 409 && error.code === 'EntityChanged');
  expect((await loadAdminEntity(db, 'contributor', String(seeded.id))) !== null).toBeTruthy();
});

test('reports an unknown contributor as 404 on delete', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  await expect(() => deleteAdminEntity(db, 'contributor', `missing${RUN}`, null)).rejects.toSatisfy((error: unknown) =>
      error instanceof EntityEditError && error.status === 404 && error.code === 'NotFound');
});

test('deletes an unlinked publisher and queues its record deletion', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const seeded = await createPublisher(`${RUN} Deletable Press`);
  const record = await loadedPublisher(db, String(seeded.id));
  await clearOutbox([seeded.atUri]);

  const deleted = await deleteAdminEntity(
    db,
    'publisher',
    String(seeded.id),
    record.revision
  );

  expect(deleted).toBe(seeded.id);
  expect(await loadAdminEntity(db, 'publisher', String(seeded.id))).toBe(null);
  expect(await outbox(seeded.atUri)).toEqual({
    collection: PUBLISHER_COLLECTION,
    op: 'delete'
  });
});

test('refuses to delete a publisher still linked to an edition identifier', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const contributor = await createContributor(`${RUN} Linked Press Author`);
  const publisher = await createPublisher(`${RUN} Linked Press`);
  const editionUri = await seedEdition(contributor.id, publisher.id);
  const record = await loadedPublisher(db, String(publisher.id));

  await expect(() => deleteAdminEntity(db, 'publisher', String(publisher.id), record.revision)).rejects.toSatisfy((error: unknown) => {
      expect(error instanceof EntityEditError).toBeTruthy();
      expect(error.status).toBe(409);
      expect(error.code).toBe('EntityInUse');
      expect(error.message).toMatch(/linked to 1 edition identifier/);
      expect(error.message).toMatch(/merge it into another publisher/);
      return true;
    });

  expect((await loadAdminEntity(db, 'publisher', String(publisher.id))) !== null, 'a refused delete leaves the publisher and its link in place').toBeTruthy();
  const links = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM edition_identifier_publishers WHERE edition_uri = $1',
    [editionUri]
  );
  expect(links.rows[0]?.n).toBe(1);
});
