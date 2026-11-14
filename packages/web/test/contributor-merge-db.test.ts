/**
 * Merge semantics against a real catalog schema.
 *
 * The merge deletes a row and republishes editions, so these tests cover the
 * parts a type check cannot: which credit moves, which is dropped, which `ref`
 * is cleared, what the survivor absorbs, and which outbox rows the triggers
 * queue. They skip when `DATABASE_URL` is unreachable, like the other catalog
 * integration tests.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import {
  ContributorMergeError,
  mergeContributors,
  previewContributorMerge
} from '../src/lib/server/admin/entity-merge.ts';
import { loadAdminEntity } from '../src/lib/server/admin/entity-read.ts';
import type { AdminContributorRecord } from '../src/lib/admin/types.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const RUN = `${process.pid}-${Date.now()}`;
const AUTHORITY = `did:plc:contribmerge${process.pid}`;
const EDITION_COLLECTION = 'community.lexicon.media.book.edition';
const CONTRIBUTOR_COLLECTION = 'net.olamaelcu.livtet.biblio.contributor';

let pool: pg.Pool | undefined;
let ready = false;
let sequence = 0;

function label(): string {
  sequence += 1;
  return `contribmerge${RUN.replace(/[^a-z0-9]/gi, '')}${sequence}`;
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
  await pool.query('DELETE FROM contributors WHERE name LIKE $1', [`${RUN}%`]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [prefix]);
}

type Seed = {
  id: number;
  name: string;
  atUri: string;
  identifiers: unknown[];
  description: string | null;
  nameInverted: string | null;
  imageUrl: string | null;
  born: string | null;
  died: string | null;
};

type SeedExtras = {
  description?: string;
  nameInverted?: string;
  imageUrl?: string;
  born?: string;
  died?: string;
};

async function createContributor(
  name: string,
  identifiers: unknown[] = [],
  extras: SeedExtras = {}
): Promise<Seed> {
  const result = await (pool as pg.Pool).query<{
    id: string;
    at_uri: string;
  }>(
    `INSERT INTO contributors
       (name, identifiers, at_uri, description, name_inverted, image_url, born, died)
     VALUES ($1, $2::jsonb, 'at://' || $3 || '/' || $4 || '/' || editions_next_tid(),
             $5, $6, $7, $8, $9)
     RETURNING id, at_uri`,
    [
      name,
      JSON.stringify(identifiers),
      AUTHORITY,
      CONTRIBUTOR_COLLECTION,
      extras.description ?? null,
      extras.nameInverted ?? null,
      extras.imageUrl ?? null,
      extras.born ?? null,
      extras.died ?? null
    ]
  );
  const row = result.rows[0];
  assert.ok(row, 'expected the contributor insert to return a row');
  return {
    id: Number(row.id),
    name,
    atUri: row.at_uri,
    identifiers,
    description: extras.description ?? null,
    nameInverted: extras.nameInverted ?? null,
    imageUrl: extras.imageUrl ?? null,
    born: extras.born ?? null,
    died: extras.died ?? null
  };
}

async function seedEdition(credits: Array<{ contributorId: number; position: number; role: string; ref?: string | null }>): Promise<string> {
  const rkey = label();
  const uri = `at://${AUTHORITY}/${EDITION_COLLECTION}/${rkey}`;
  await (pool as pg.Pool).query(
    `INSERT INTO editions (uri, rkey, title, created_at, indexed_at)
     VALUES ($1, $2, 'Merge fixture', now(), now())`,
    [uri, rkey]
  );
  for (const credit of credits) {
    await (pool as pg.Pool).query(
      `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role, ref)
       VALUES ($1, $2, $3, $4, $5)`,
      [uri, credit.contributorId, credit.position, credit.role, credit.ref ?? null]
    );
  }
  return uri;
}

async function creditsOf(editionUri: string): Promise<Array<{ contributorId: number; position: number; role: string; ref: string | null }>> {
  const result = await (pool as pg.Pool).query<{
    contributor_id: string;
    position: number;
    role: string;
    ref: string | null;
  }>(
    `SELECT contributor_id, position, role, ref
       FROM edition_contributors
      WHERE edition_uri = $1
      ORDER BY position`,
    [editionUri]
  );
  return result.rows.map((row) => ({
    contributorId: Number(row.contributor_id),
    position: row.position,
    role: row.role,
    ref: row.ref
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

async function loaded(db: pg.Pool, ref: string): Promise<AdminContributorRecord> {
  const record = await loadAdminEntity(db, 'contributor', ref);
  assert.ok(record, `expected contributor ${ref} to load`);
  return record;
}

function isMergeError(status: number, code: string) {
  return (error: unknown) =>
    error instanceof ContributorMergeError && error.status === status && error.code === code;
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

test('absorbs a contributor: repoints credits, drops duplicates, fills the survivor', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const name = `${RUN} Absorbed Person`;
  const survivor = await createContributor(name, [{ issuer: 'isni', value: '111' }]);
  const absorbed = await createContributor(
    name,
    [
      { issuer: 'isni', value: '111', url: 'https://isni.example/111' },
      { issuer: 'openlibrary', value: 'OL9A' }
    ],
    {
      description: 'Provider bio',
      nameInverted: 'Person, Absorbed',
      imageUrl: 'https://example.org/person.jpg',
      born: '1920-10-08',
      died: '1986-02-11'
    }
  );

  // E1: only the absorbed row is credited, with a ref at its own record.
  const e1 = await seedEdition([
    { contributorId: absorbed.id, position: 1, role: 'A01', ref: absorbed.atUri }
  ]);
  // E2: the survivor already holds the same role there ('author' is the legacy
  // token for A01), so the absorbed credit is redundant.
  const e2 = await seedEdition([
    { contributorId: survivor.id, position: 1, role: 'author' },
    { contributorId: absorbed.id, position: 2, role: 'A01' }
  ]);
  // E3: a different role is a real second credit and must survive.
  const e3 = await seedEdition([
    { contributorId: survivor.id, position: 1, role: 'A01' },
    { contributorId: absorbed.id, position: 2, role: 'A15' }
  ]);
  // E4: an unrelated per-edge ref must be preserved.
  const e4 = await seedEdition([
    {
      contributorId: absorbed.id,
      position: 1,
      role: 'A01',
      ref: 'at://did:plc:elsewhere/community.lexicon.media.book.contributor/ref1'
    }
  ]);
  await clearOutbox([survivor.atUri, absorbed.atUri, e1, e2, e3, e4]);

  const before = await loaded(db, String(absorbed.id));
  const target = await loaded(db, String(survivor.id));
  const result = await mergeContributors(db, {
    source: String(absorbed.id),
    target: String(survivor.id),
    sourceRevision: before.revision,
    targetRevision: target.revision
  });

  assert.deepEqual(result.plan, {
    moved: 3,
    dropped: 1,
    identifiersAdded: 1,
    fields: ['description', 'nameInverted', 'imageUrl', 'born', 'died']
  });
  assert.equal(result.absorbedId, absorbed.id);
  assert.equal(result.absorbedAtUri, absorbed.atUri);

  assert.equal(result.target.id, survivor.id);
  assert.equal(result.target.atUri, survivor.atUri);
  assert.equal(result.target.name, name, 'the survivor keeps its name');
  assert.equal(result.target.description, 'Provider bio');
  assert.equal(result.target.nameInverted, 'Person, Absorbed');
  assert.equal(result.target.imageUrl, 'https://example.org/person.jpg');
  assert.equal(result.target.born, '1920-10-08');
  assert.equal(result.target.died, '1986-02-11');
  assert.deepEqual(result.target.identifiers, [
    { issuer: 'isni', value: '111' },
    { issuer: 'openlibrary', value: 'OL9A' }
  ]);
  // The record shape drops provider URLs; the stored bag keeps the one only the
  // absorbed row had.
  const stored = await db.query<{ identifiers: Array<{ issuer: string; value: string; url?: string }> }>(
    'SELECT identifiers FROM contributors WHERE id = $1',
    [survivor.id]
  );
  assert.deepEqual(stored.rows[0]?.identifiers, [
    { issuer: 'isni', value: '111', url: 'https://isni.example/111' },
    { issuer: 'openlibrary', value: 'OL9A' }
  ]);

  const gone = await db.query('SELECT id FROM contributors WHERE id = $1', [absorbed.id]);
  assert.equal(gone.rowCount, 0, 'the absorbed row is deleted');

  assert.deepEqual(await creditsOf(e1), [
    { contributorId: survivor.id, position: 1, role: 'A01', ref: null }
  ]);
  assert.deepEqual(await creditsOf(e2), [
    { contributorId: survivor.id, position: 1, role: 'author', ref: null }
  ]);
  assert.deepEqual(await creditsOf(e3), [
    { contributorId: survivor.id, position: 1, role: 'A01', ref: null },
    { contributorId: survivor.id, position: 2, role: 'A15', ref: null }
  ]);
  assert.equal(
    (await creditsOf(e4))[0]?.ref,
    'at://did:plc:elsewhere/community.lexicon.media.book.contributor/ref1',
    'an unrelated per-edge ref survives'
  );

  assert.deepEqual(await outbox(absorbed.atUri), {
    collection: CONTRIBUTOR_COLLECTION,
    op: 'delete'
  });
  assert.deepEqual(await outbox(survivor.atUri), {
    collection: CONTRIBUTOR_COLLECTION,
    op: 'update'
  });
  for (const editionUri of [e1, e2, e3, e4]) {
    assert.deepEqual(
      await outbox(editionUri),
      { collection: EDITION_COLLECTION, op: 'update' },
      `${editionUri} must be republished`
    );
  }

  const view = await db.query<{ contributors: Array<{ name: string; ref: string | null }> }>(
    'SELECT contributors FROM appview_book WHERE uri = $1',
    [e1]
  );
  assert.equal(view.rows[0]?.contributors[0]?.name, name);
  assert.equal(
    view.rows[0]?.contributors[0]?.ref,
    survivor.atUri,
    'the read model falls back to the survivor URI'
  );
});

test('keeps a curated survivor and previews the same plan without writing', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const name = `${RUN} Curated Person`;
  const survivor = await createContributor(
    name,
    [
      { issuer: 'isni', value: '222' },
      { issuer: 'openlibrary', value: 'OL7A' }
    ],
    { description: 'Curated bio', born: '1900-01-01' }
  );
  const absorbed = await createContributor(name, [{ issuer: 'isni', value: '222' }], {
    description: 'Provider bio',
    born: '1899-12-31',
    died: '1970-01-01'
  });
  const editionUri = await seedEdition([
    { contributorId: absorbed.id, position: 1, role: 'A01' }
  ]);
  await clearOutbox([survivor.atUri, absorbed.atUri, editionUri]);

  const preview = await previewContributorMerge(db, {
    source: String(absorbed.id),
    target: String(survivor.id)
  });
  assert.deepEqual(preview.plan, {
    moved: 1,
    dropped: 0,
    identifiersAdded: 0,
    fields: ['died']
  });
  assert.equal(preview.source.id, absorbed.id);
  assert.equal(preview.target.id, survivor.id);
  // A preview never writes.
  assert.deepEqual(await creditsOf(editionUri), [
    { contributorId: absorbed.id, position: 1, role: 'A01', ref: null }
  ]);
  assert.equal(await outbox(absorbed.atUri), null);
  assert.equal(
    (await db.query('SELECT id FROM contributors WHERE id = $1', [absorbed.id])).rowCount,
    1
  );

  const result = await mergeContributors(db, {
    source: String(absorbed.id),
    target: String(survivor.id),
    sourceRevision: preview.source.revision,
    targetRevision: preview.target.revision
  });
  assert.deepEqual(result.plan, preview.plan);
  assert.equal(result.target.description, 'Curated bio', 'a curated bio is never overwritten');
  assert.equal(result.target.born, '1900-01-01', 'a populated field is never overwritten');
  assert.equal(result.target.died, '1970-01-01', 'a blank field is filled');
  assert.equal(result.target.identifiers.length, 2, 'the union does not duplicate pairs');
});

test('rejects a stale revision and leaves both rows and credits alone', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const name = `${RUN} Stale Person`;
  const survivor = await createContributor(name, [{ issuer: 'isni', value: '333' }]);
  const absorbed = await createContributor(name, [
    { issuer: 'isni', value: '333' },
    { issuer: 'viaf', value: '33' }
  ]);
  const editionUri = await seedEdition([
    { contributorId: absorbed.id, position: 1, role: 'A01' }
  ]);

  const source = await loaded(db, String(absorbed.id));
  const target = await loaded(db, String(survivor.id));
  await db.query(`UPDATE contributors SET description = 'changed underneath' WHERE id = $1`, [
    target.id
  ]);

  await assert.rejects(
    () =>
      mergeContributors(db, {
        source: String(absorbed.id),
        target: String(survivor.id),
        sourceRevision: source.revision,
        targetRevision: target.revision
      }),
    isMergeError(409, 'EntityChanged')
  );

  assert.deepEqual(await creditsOf(editionUri), [
    { contributorId: absorbed.id, position: 1, role: 'A01', ref: null }
  ]);
  assert.equal(
    (await db.query('SELECT id FROM contributors WHERE id = $1', [absorbed.id])).rowCount,
    1
  );
  const kept = await db.query<{ description: string | null }>(
    'SELECT description FROM contributors WHERE id = $1',
    [target.id]
  );
  assert.equal(kept.rows[0]?.description, 'changed underneath');
});

test('refuses the same row, an unknown row, and a missing revision', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const person = await createContributor(`${RUN} Refused Person`, [
    { issuer: 'isni', value: '444' }
  ]);
  const record = await loaded(db, String(person.id));

  await assert.rejects(
    () =>
      mergeContributors(db, {
        source: String(person.id),
        target: String(person.id),
        sourceRevision: record.revision,
        targetRevision: record.revision
      }),
    isMergeError(400, 'InvalidRequest')
  );
  await assert.rejects(
    () =>
      mergeContributors(db, {
        source: String(person.id),
        target: '999999999',
        sourceRevision: record.revision,
        targetRevision: record.revision
      }),
    isMergeError(404, 'NotFound')
  );
  await assert.rejects(
    () => mergeContributors(db, { source: String(person.id), target: '1' }),
    isMergeError(400, 'InvalidRequest')
  );
  await assert.rejects(() => mergeContributors(db, []), isMergeError(400, 'InvalidRequest'));
});

test('reports a duplicate identity collision instead of dropping the absorbed row', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const name = `${RUN} Colliding Person`;
  const survivor = await createContributor(name, [{ issuer: 'isni', value: '555' }]);
  const absorbed = await createContributor(name, [{ issuer: 'openlibrary', value: 'OL8A' }]);
  // The union of the two bags already belongs to a third row, so absorbing
  // would violate contributors_identity_idx.
  await createContributor(name, [
    { issuer: 'isni', value: '555' },
    { issuer: 'openlibrary', value: 'OL8A' }
  ]);

  const source = await loaded(db, String(absorbed.id));
  const target = await loaded(db, String(survivor.id));
  await assert.rejects(
    () =>
      mergeContributors(db, {
        source: String(absorbed.id),
        target: String(survivor.id),
        sourceRevision: source.revision,
        targetRevision: target.revision
      }),
    isMergeError(409, 'DuplicateEntity')
  );
  assert.equal(
    (await db.query('SELECT id FROM contributors WHERE id = $1', [absorbed.id])).rowCount,
    1,
    'the absorbed row survives a rejected merge'
  );
});
