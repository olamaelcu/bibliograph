/**
 * Publisher merge against the development catalog.
 *
 * The merge deletes a row and repoints identifier links, so these tests drive
 * the real transaction against `DATABASE_URL` (skipping when it is
 * unreachable) and assert the per-identifier links, the survivor's absorbed
 * fields and the publication queue the catalog triggers fill.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import {
  PublisherMergeError,
  mergePublishers,
  previewPublisherMerge
} from '../src/lib/server/admin/publisher-merge.ts';
import { loadAdminEntity } from '../src/lib/server/admin/entity-read.ts';
import type { AdminPublisherRecord } from '../src/lib/admin/types.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = `${process.pid}-${Date.now()}`;
const AUTHORITY = `did:plc:pubmerge${process.pid}`;
const EDITION_COLLECTION = 'community.lexicon.media.book.edition';
const PUBLISHER_COLLECTION = 'net.olamaelcu.livtet.biblio.publisher';

let pool: pg.Pool | undefined;
let ready = false;
let sequence = 0;

function label(): string {
  sequence += 1;
  return `pubmerge${RUN.replace(/[^a-z0-9]/gi, '')}${sequence}`;
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
  await pool.query('DELETE FROM publishers WHERE at_uri LIKE $1 OR name LIKE $2', [
    prefix,
    `${RUN}%`
  ]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [prefix]);
}

type PublisherSeed = {
  id: number;
  name: string;
  atUri: string;
  identifiers: unknown[];
  description: string | null;
  imageUrl: string | null;
  started: string | null;
  ended: string | null;
};

async function createPublisher(
  name: string,
  identifiers: unknown[] = [],
  extras: {
    description?: string;
    imageUrl?: string;
    started?: string;
    ended?: string;
  } = {}
): Promise<PublisherSeed> {
  const result = await (pool as pg.Pool).query<{ id: string; at_uri: string }>(
    `INSERT INTO publishers (name, identifiers, at_uri, description, image_url, started, ended)
     VALUES ($1, $2::jsonb, 'at://' || $3 || '/' || $4 || '/' || editions_next_tid(),
             $5, $6, $7, $8)
     RETURNING id, at_uri`,
    [
      name,
      JSON.stringify(identifiers),
      AUTHORITY,
      PUBLISHER_COLLECTION,
      extras.description ?? null,
      extras.imageUrl ?? null,
      extras.started ?? null,
      extras.ended ?? null
    ]
  );
  const row = result.rows[0];
  assert.ok(row, 'expected the publisher insert to return a row');
  return {
    id: Number(row.id),
    name,
    atUri: row.at_uri,
    identifiers,
    description: extras.description ?? null,
    imageUrl: extras.imageUrl ?? null,
    started: extras.started ?? null,
    ended: extras.ended ?? null
  };
}

type LinkSeed = { issuer: string; value: string; publisherId: number; position: number };

async function seedEdition(links: LinkSeed[]): Promise<string> {
  const rkey = label();
  const uri = `at://${AUTHORITY}/${EDITION_COLLECTION}/${rkey}`;
  await (pool as pg.Pool).query(
    `INSERT INTO editions (uri, rkey, title, created_at, indexed_at)
     VALUES ($1, $2, 'Publisher merge fixture', now(), now())`,
    [uri, rkey]
  );
  const seen = new Set<string>();
  for (const link of links) {
    const key = `${link.issuer}\u0000${link.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      await (pool as pg.Pool).query(
        'INSERT INTO edition_identifiers (edition_uri, issuer, value) VALUES ($1, $2, $3)',
        [uri, link.issuer, link.value]
      );
    }
    await (pool as pg.Pool).query(
      `INSERT INTO edition_identifier_publishers
         (edition_uri, issuer, value, publisher_id, position)
       VALUES ($1, $2, $3, $4, $5)`,
      [uri, link.issuer, link.value, link.publisherId, link.position]
    );
  }
  return uri;
}

async function linksOf(
  editionUri: string
): Promise<Array<{ issuer: string; value: string; publisherId: number; position: number }>> {
  const result = await (pool as pg.Pool).query<{
    issuer: string;
    value: string;
    publisher_id: string;
    position: number;
  }>(
    `SELECT issuer, value, publisher_id, position
       FROM edition_identifier_publishers
      WHERE edition_uri = $1
      ORDER BY identifier_shape_rank(issuer), issuer, value, position`,
    [editionUri]
  );
  return result.rows.map((row) => ({
    issuer: row.issuer,
    value: row.value,
    publisherId: Number(row.publisher_id),
    position: row.position
  }));
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

async function loaded(db: pg.Pool, ref: string): Promise<AdminPublisherRecord> {
  const record = await loadAdminEntity(db, 'publisher', ref);
  assert.ok(record, `expected publisher ${ref} to load`);
  return record;
}

function isMergeError(status: number, code: string) {
  return (error: unknown) =>
    error instanceof PublisherMergeError && error.status === status && error.code === code;
}

function pairs(record: AdminPublisherRecord): string[] {
  return record.identifiers.map((identifier) => `${identifier.issuer}:${identifier.value}`);
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

test('absorbs a publisher: repoints links, drops redundant ones, fills the survivor', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const name = `${RUN} Absorbed Press`;
  const survivor = await createPublisher(name, [{ issuer: 'isni', value: '111' }]);
  const absorbed = await createPublisher(
    name,
    [
      { issuer: 'isni', value: '111', url: 'https://isni.example/111' },
      { issuer: 'openlibrary', value: 'OL9P' }
    ],
    {
      description: 'Provider blurb',
      imageUrl: 'https://example.org/press.png',
      started: '1972-01-01',
      ended: '1998-12-31'
    }
  );

  // E1: only the absorbed row is linked, so its link moves.
  const e1 = await seedEdition([
    { issuer: 'isbn13', value: '9780000000101', publisherId: absorbed.id, position: 1 }
  ]);
  // E2: the survivor already credits that identifier, so the absorbed link is
  // redundant and must not become a second link for the same publisher.
  const e2 = await seedEdition([
    { issuer: 'isbn13', value: '9780000000102', publisherId: survivor.id, position: 1 },
    { issuer: 'isbn13', value: '9780000000102', publisherId: absorbed.id, position: 2 }
  ]);
  // E3: a different identifier on the same edition is a real second link.
  const e3 = await seedEdition([
    { issuer: 'isbn13', value: '9780000000103', publisherId: survivor.id, position: 1 },
    { issuer: 'oclc', value: '222222', publisherId: absorbed.id, position: 1 }
  ]);
  await clearOutbox([survivor.atUri, absorbed.atUri, e1, e2, e3]);

  const before = await loaded(db, String(absorbed.id));
  const target = await loaded(db, String(survivor.id));
  const result = await mergePublishers(db, {
    source: String(absorbed.id),
    target: String(survivor.id),
    sourceRevision: before.revision,
    targetRevision: target.revision
  });

  assert.deepEqual(result.plan, {
    moved: 2,
    dropped: 1,
    identifiersAdded: 1,
    fields: ['description', 'imageUrl', 'started', 'ended']
  });
  assert.equal(result.absorbedId, absorbed.id);
  assert.equal(result.absorbedAtUri, absorbed.atUri);

  assert.equal(result.target.id, survivor.id);
  assert.equal(result.target.atUri, survivor.atUri);
  assert.equal(result.target.name, name, 'the survivor keeps its name');
  assert.equal(result.target.description, 'Provider blurb');
  assert.equal(result.target.imageUrl, 'https://example.org/press.png');
  assert.equal(result.target.started, '1972-01-01');
  assert.equal(result.target.ended, '1998-12-31');
  assert.deepEqual(pairs(result.target).sort(), ['isni:111', 'openlibrary:OL9P']);

  assert.equal(
    (await db.query('SELECT id FROM publishers WHERE id = $1', [absorbed.id])).rowCount,
    0,
    'the absorbed row is gone'
  );

  assert.deepEqual(await linksOf(e1), [
    { issuer: 'isbn13', value: '9780000000101', publisherId: survivor.id, position: 1 }
  ]);
  assert.deepEqual(await linksOf(e2), [
    { issuer: 'isbn13', value: '9780000000102', publisherId: survivor.id, position: 1 }
  ]);
  assert.deepEqual(await linksOf(e3), [
    { issuer: 'isbn13', value: '9780000000103', publisherId: survivor.id, position: 1 },
    { issuer: 'oclc', value: '222222', publisherId: survivor.id, position: 1 }
  ]);

  // Publication is the triggers' job: the absorbed record is deleted, the
  // survivor republished, and every edition whose links changed queued.
  assert.deepEqual(await outbox(absorbed.atUri), {
    collection: PUBLISHER_COLLECTION,
    op: 'delete'
  });
  for (const uri of [survivor.atUri, e1, e2, e3]) {
    assert.ok(await outbox(uri), `expected ${uri} to be queued`);
  }
});

test('previews the same plan without writing', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const name = `${RUN} Preview Press`;
  const survivor = await createPublisher(name, [{ issuer: 'isni', value: '333' }]);
  const absorbed = await createPublisher(name, [{ issuer: 'openlibrary', value: 'OL3P' }], {
    description: 'Absorbed blurb'
  });
  const edition = await seedEdition([
    { issuer: 'isbn13', value: '9780000000201', publisherId: absorbed.id, position: 1 }
  ]);
  await clearOutbox([survivor.atUri, absorbed.atUri, edition]);

  const preview = await previewPublisherMerge(db, {
    source: String(absorbed.id),
    target: String(survivor.id)
  });
  assert.deepEqual(preview.plan, {
    moved: 1,
    dropped: 0,
    identifiersAdded: 1,
    fields: ['description']
  });

  assert.equal(
    (await db.query('SELECT id FROM publishers WHERE id = $1', [absorbed.id])).rowCount,
    1,
    'a preview deletes nothing'
  );
  assert.deepEqual(await linksOf(edition), [
    { issuer: 'isbn13', value: '9780000000201', publisherId: absorbed.id, position: 1 }
  ]);
  assert.deepEqual(await outbox(absorbed.atUri), null, 'a preview queues nothing');

  const source = await loaded(db, String(absorbed.id));
  const target = await loaded(db, String(survivor.id));
  const result = await mergePublishers(db, {
    source: String(absorbed.id),
    target: String(survivor.id),
    sourceRevision: source.revision,
    targetRevision: target.revision
  });
  assert.deepEqual(result.plan, preview.plan, 'the merge does what the preview promised');
});

test('rejects a stale revision and leaves both rows and links alone', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const name = `${RUN} Stale Press`;
  const survivor = await createPublisher(name, [{ issuer: 'isni', value: '444' }]);
  const absorbed = await createPublisher(name, [{ issuer: 'openlibrary', value: 'OL4P' }]);
  const edition = await seedEdition([
    { issuer: 'isbn13', value: '9780000000301', publisherId: absorbed.id, position: 1 }
  ]);

  const source = await loaded(db, String(absorbed.id));
  const target = await loaded(db, String(survivor.id));
  // A concurrent edit moves the survivor's revision past what the operator saw.
  await db.query('UPDATE publishers SET description = $2 WHERE id = $1', [
    survivor.id,
    'Edited after load'
  ]);

  await assert.rejects(
    () =>
      mergePublishers(db, {
        source: String(absorbed.id),
        target: String(survivor.id),
        sourceRevision: source.revision,
        targetRevision: target.revision
      }),
    isMergeError(409, 'EntityChanged')
  );

  assert.equal(
    (await db.query('SELECT id FROM publishers WHERE id = $1', [absorbed.id])).rowCount,
    1
  );
  assert.deepEqual(await linksOf(edition), [
    { issuer: 'isbn13', value: '9780000000301', publisherId: absorbed.id, position: 1 }
  ]);
});

test('refuses the same row, an unknown row, and a missing revision', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const publisher = await createPublisher(`${RUN} Solo Press`);
  const record = await loaded(db, String(publisher.id));

  await assert.rejects(
    () =>
      mergePublishers(db, {
        source: String(publisher.id),
        target: String(publisher.id),
        sourceRevision: record.revision,
        targetRevision: record.revision
      }),
    isMergeError(400, 'InvalidRequest')
  );
  await assert.rejects(
    () =>
      mergePublishers(db, {
        source: String(publisher.id),
        target: `missing${RUN}`,
        sourceRevision: record.revision,
        targetRevision: record.revision
      }),
    isMergeError(404, 'NotFound')
  );
  await assert.rejects(
    () => mergePublishers(db, { source: String(publisher.id), target: '1' }),
    isMergeError(400, 'InvalidRequest')
  );
  await assert.rejects(() => mergePublishers(db, []), isMergeError(400, 'InvalidRequest'));
});

test('reports a duplicate identity collision instead of dropping the absorbed row', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const name = `${RUN} Colliding Press`;
  const survivor = await createPublisher(name, [{ issuer: 'isni', value: '555' }]);
  const absorbed = await createPublisher(name, [{ issuer: 'openlibrary', value: 'OL8P' }]);
  // The union of the two bags already belongs to a third row, so absorbing
  // would violate publishers_identity_idx.
  await createPublisher(name, [
    { issuer: 'isni', value: '555' },
    { issuer: 'openlibrary', value: 'OL8P' }
  ]);

  const source = await loaded(db, String(absorbed.id));
  const target = await loaded(db, String(survivor.id));
  await assert.rejects(
    () =>
      mergePublishers(db, {
        source: String(absorbed.id),
        target: String(survivor.id),
        sourceRevision: source.revision,
        targetRevision: target.revision
      }),
    isMergeError(409, 'DuplicateEntity')
  );
  assert.equal(
    (await db.query('SELECT id FROM publishers WHERE id = $1', [absorbed.id])).rowCount,
    1,
    'the absorbed row survives a rejected merge'
  );
});
