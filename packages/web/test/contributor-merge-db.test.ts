/**
 * Merge semantics against a real catalog schema.
 *
 * The merge deletes a row and republishes editions, so these tests cover the
 * parts a type check cannot: which credit moves, which is dropped, which `ref`
 * is cleared, what the survivor absorbs, and which outbox rows the triggers
 * queue. They skip when `DATABASE_URL` is unreachable, like the other catalog
 * integration tests.
 */

import { expect, test, afterAll, beforeAll } from 'vitest';

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
  await pool.query('DELETE FROM books WHERE uri LIKE $1', [prefix]);
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
  expect(row, 'expected the contributor insert to return a row').toBeTruthy();
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
    `INSERT INTO books (uri, rkey, title, created_at, indexed_at)
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
  expect(record, `expected contributor ${ref} to load`).toBeTruthy();
  return record;
}

function isMergeError(status: number, code: string) {
  return (error: unknown) =>
    error instanceof ContributorMergeError && error.status === status && error.code === code;
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

  expect(result.plan).toEqual({
    moved: 3,
    dropped: 1,
    identifiersAdded: 1,
    fields: ['description', 'nameInverted', 'imageUrl', 'born', 'died']
  });
  expect(result.absorbedId).toBe(absorbed.id);
  expect(result.absorbedAtUri).toBe(absorbed.atUri);

  expect(result.target.id).toBe(survivor.id);
  expect(result.target.atUri).toBe(survivor.atUri);
  expect(result.target.name, 'the survivor keeps its name').toBe(name);
  expect(result.target.description).toBe('Provider bio');
  expect(result.target.nameInverted).toBe('Person, Absorbed');
  expect(result.target.imageUrl).toBe('https://example.org/person.jpg');
  expect(result.target.born).toBe('1920-10-08');
  expect(result.target.died).toBe('1986-02-11');
  expect(result.target.identifiers).toEqual([
    { issuer: 'isni', value: '111' },
    { issuer: 'openlibrary', value: 'OL9A' }
  ]);
  // The record shape drops provider URLs; the stored bag keeps the one only the
  // absorbed row had.
  const stored = await db.query<{ identifiers: Array<{ issuer: string; value: string; url?: string }> }>(
    'SELECT identifiers FROM contributors WHERE id = $1',
    [survivor.id]
  );
  expect(stored.rows[0]?.identifiers).toEqual([
    { issuer: 'isni', value: '111', url: 'https://isni.example/111' },
    { issuer: 'openlibrary', value: 'OL9A' }
  ]);

  const gone = await db.query('SELECT id FROM contributors WHERE id = $1', [absorbed.id]);
  expect(gone.rowCount, 'the absorbed row is deleted').toBe(0);

  expect(await creditsOf(e1)).toEqual([
    { contributorId: survivor.id, position: 1, role: 'A01', ref: null }
  ]);
  expect(await creditsOf(e2)).toEqual([
    { contributorId: survivor.id, position: 1, role: 'author', ref: null }
  ]);
  expect(await creditsOf(e3)).toEqual([
    { contributorId: survivor.id, position: 1, role: 'A01', ref: null },
    { contributorId: survivor.id, position: 2, role: 'A15', ref: null }
  ]);
  expect((await creditsOf(e4))[0]?.ref, 'an unrelated per-edge ref survives').toBe('at://did:plc:elsewhere/community.lexicon.media.book.contributor/ref1');

  expect(await outbox(absorbed.atUri)).toEqual({
    collection: CONTRIBUTOR_COLLECTION,
    op: 'delete'
  });
  expect(await outbox(survivor.atUri)).toEqual({
    collection: CONTRIBUTOR_COLLECTION,
    op: 'update'
  });
  for (const editionUri of [e1, e2, e3, e4]) {
    expect(await outbox(editionUri), `${editionUri} must be republished`).toEqual({ collection: EDITION_COLLECTION, op: 'update' });
  }

  const view = await db.query<{ contributors: Array<{ name: string; ref: string | null }> }>(
    'SELECT contributors FROM appview_book WHERE uri = $1',
    [e1]
  );
  expect(view.rows[0]?.contributors[0]?.name).toBe(name);
  expect(view.rows[0]?.contributors[0]?.ref, 'the read model falls back to the survivor URI').toBe(survivor.atUri);
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
  expect(preview.plan).toEqual({
    moved: 1,
    dropped: 0,
    identifiersAdded: 0,
    fields: ['died']
  });
  expect(preview.source.id).toBe(absorbed.id);
  expect(preview.target.id).toBe(survivor.id);
  // A preview never writes.
  expect(await creditsOf(editionUri)).toEqual([
    { contributorId: absorbed.id, position: 1, role: 'A01', ref: null }
  ]);
  expect(await outbox(absorbed.atUri)).toBe(null);
  expect((await db.query('SELECT id FROM contributors WHERE id = $1', [absorbed.id])).rowCount).toBe(1);

  const result = await mergeContributors(db, {
    source: String(absorbed.id),
    target: String(survivor.id),
    sourceRevision: preview.source.revision,
    targetRevision: preview.target.revision
  });
  expect(result.plan).toEqual(preview.plan);
  expect(result.target.description, 'a curated bio is never overwritten').toBe('Curated bio');
  expect(result.target.born, 'a populated field is never overwritten').toBe('1900-01-01');
  expect(result.target.died, 'a blank field is filled').toBe('1970-01-01');
  expect(result.target.identifiers.length, 'the union does not duplicate pairs').toBe(2);
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

  await expect(() =>
      mergeContributors(db, {
        source: String(absorbed.id),
        target: String(survivor.id),
        sourceRevision: source.revision,
        targetRevision: target.revision
      })).rejects.toSatisfy(isMergeError(409, 'EntityChanged'));

  expect(await creditsOf(editionUri)).toEqual([
    { contributorId: absorbed.id, position: 1, role: 'A01', ref: null }
  ]);
  expect((await db.query('SELECT id FROM contributors WHERE id = $1', [absorbed.id])).rowCount).toBe(1);
  const kept = await db.query<{ description: string | null }>(
    'SELECT description FROM contributors WHERE id = $1',
    [target.id]
  );
  expect(kept.rows[0]?.description).toBe('changed underneath');
});

test('refuses the same row, an unknown row, and a missing revision', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const person = await createContributor(`${RUN} Refused Person`, [
    { issuer: 'isni', value: '444' }
  ]);
  const record = await loaded(db, String(person.id));

  await expect(() =>
      mergeContributors(db, {
        source: String(person.id),
        target: String(person.id),
        sourceRevision: record.revision,
        targetRevision: record.revision
      })).rejects.toSatisfy(isMergeError(400, 'InvalidRequest'));
  await expect(() =>
      mergeContributors(db, {
        source: String(person.id),
        target: '999999999',
        sourceRevision: record.revision,
        targetRevision: record.revision
      })).rejects.toSatisfy(isMergeError(404, 'NotFound'));
  await expect(() => mergeContributors(db, { source: String(person.id), target: '1' })).rejects.toSatisfy(isMergeError(400, 'InvalidRequest'));
  await expect(() => mergeContributors(db, [])).rejects.toSatisfy(isMergeError(400, 'InvalidRequest'));
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
  await expect(() =>
      mergeContributors(db, {
        source: String(absorbed.id),
        target: String(survivor.id),
        sourceRevision: source.revision,
        targetRevision: target.revision
      })).rejects.toSatisfy(isMergeError(409, 'DuplicateEntity'));
  expect((await db.query('SELECT id FROM contributors WHERE id = $1', [absorbed.id])).rowCount, 'the absorbed row survives a rejected merge').toBe(1);
});

test('a single verified account moves to the survivor', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const survivor = await createContributor(`${RUN} One Account Survivor`);
  const absorbed = await createContributor(`${RUN} One Account Absorbed`);
  // Only the absorbed row is verified; the survivor has no binding, so there is
  // no clash and the link is moved rather than dropped.
  const subject = 'did:plc:mergeoneaccount';
  const record = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.knownContributor/3merge1`;
  await db.query(
    `INSERT INTO contributor_identities (contributor_id, did, at_uri, issued_by)
     VALUES ($1, $2, $3, 'did:plc:mergelibrarian')`,
    [absorbed.id, subject, record]
  );

  const source = await loaded(db, String(absorbed.id));
  const target = await loaded(db, String(survivor.id));
  await mergeContributors(db, {
    source: String(absorbed.id),
    target: String(survivor.id),
    sourceRevision: source.revision,
    targetRevision: target.revision
  });

  const bound = await db.query(
    'SELECT contributor_id FROM contributor_identities WHERE did = $1',
    [subject]
  );
  expect(Number(bound.rows[0]?.contributor_id)).toBe(survivor.id);

  // The move requeues the record under the survivor, which is what makes the
  // published link re-read the survivor's URI. The op stays `create` here
  // because nothing had published it yet — `pds-publish` chooses create vs
  // update from `pds_cids` anyway, so the queue is only a flag.
  const queued = await db.query('SELECT collection FROM pds_outbox WHERE uri = $1', [record]);
  expect(queued.rows).toEqual([
    { collection: 'net.olamaelcu.livtet.biblio.knownContributor' }
  ]);
});

test('a binding on both rows keeps the survivor and deletes the absorbed record', async (t) => {
  const db = requiredPool(t);
  if (!db) return;
  const survivor = await createContributor(`${RUN} Two Accounts Survivor`);
  const absorbed = await createContributor(`${RUN} Two Accounts Absorbed`);
  const keptRecord = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.knownContributor/3merge2`;
  const droppedRecord = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.knownContributor/3merge3`;
  await db.query(
    `INSERT INTO contributor_identities (contributor_id, did, at_uri)
     VALUES ($1, 'did:plc:mergetwokept', $2), ($3, 'did:plc:mergetwodropped', $4)`,
    [survivor.id, keptRecord, absorbed.id, droppedRecord]
  );

  const source = await loaded(db, String(absorbed.id));
  const target = await loaded(db, String(survivor.id));
  await mergeContributors(db, {
    source: String(absorbed.id),
    target: String(survivor.id),
    sourceRevision: source.revision,
    targetRevision: target.revision
  });

  const rows = await db.query(
    `SELECT did FROM contributor_identities WHERE did LIKE 'did:plc:mergetwo%' ORDER BY did`
  );
  expect(rows.rows).toEqual([{ did: 'did:plc:mergetwokept' }]);

  const queued = await db.query('SELECT op FROM pds_outbox WHERE uri = $1', [droppedRecord]);
  expect(queued.rows).toEqual([{ op: 'delete' }]);
});
