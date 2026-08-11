import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, clearSqliteTables } from '../test-utils/db.js';
import { schema } from '../db/connection.js';
import {
  catalogBookToBookData,
  type BookhiveCatalogRecord,
} from './mapper.js';
import { importBookhiveCatalogBook } from './importer.js';
import { COLLECTIONS, makeRecordUri } from '../records.js';
import { generateRkey } from '../rkey.js';

const SERVICE_DID = 'did:plc:service';
process.env.ATP_SERVICE_DID = SERVICE_DID;

function baseRecord(): BookhiveCatalogRecord {
  return {
    $type: 'buzz.bookhive.catalogBook',
    id: 'M5fR8aBcDeFgHiJkLmNoP',
    title: 'Dune',
    authors: 'Frank Herbert',
    thumbnail: 'https://bookhive.buzz/covers/M5fR8-thumb.jpg',
    description: 'A desert planet.',
    genres: ['Science Fiction'],
    identifiers: { isbn13: '9780441172719', isbn10: '0441172717', goodreadsId: '17347618' },
    createdAt: '2026-01-15T12:00:00.000Z',
    updatedAt: '2026-02-20T18:30:00.000Z',
  };
}

const { db } = createTestDb();

function seedAuthorRole(): void {
  const rkey = generateRkey();
  db.insert(schema.contributorTypes)
    .values({
      uri: makeRecordUri(SERVICE_DID, COLLECTIONS.contributorType, rkey),
      did: SERVICE_DID,
      name: 'author',
      description: 'Original writer of the work.',
      createdAt: new Date().toISOString(),
    })
    .run();
}

beforeEach(() => {
  clearSqliteTables((db as any).$sqlite);
  seedAuthorRole();
});

describe('importBookhiveCatalogBook', () => {
  it('inserts a book with a deterministic URI', async () => {
    const mapped = catalogBookToBookData(baseRecord(), { serviceDid: SERVICE_DID });
    await importBookhiveCatalogBook(db, mapped);

    const row = db
      .select()
      .from(schema.books)
      .where(eq(schema.books.uri, mapped.uri))
      .get();
    expect(row).toBeDefined();
    expect(row!.title).toBe('Dune');
    expect(row!.author).toBe('Frank Herbert');
    expect(row!.isbn).toBe('9780441172719');
    expect(row!.status).toBe('active');
    expect(row!.did).toBe(SERVICE_DID);
    expect(row!.categories).toEqual(['Science Fiction']);
    expect(row!.identifiers).toEqual([
      { type: 'hiveId', value: 'M5fR8aBcDeFgHiJkLmNoP' },
      { type: 'isbn13', value: '9780441172719' },
      { type: 'isbn10', value: '0441172717' },
      { type: 'goodreadsId', value: '17347618' },
    ]);
  });

  it('creates a contributor and a book_contributors join row referencing the author role', async () => {
    const mapped = catalogBookToBookData(baseRecord(), { serviceDid: SERVICE_DID });
    await importBookhiveCatalogBook(db, mapped);

    const contributors = db.select().from(schema.contributors).all();
    expect(contributors).toHaveLength(1);
    expect(contributors[0].name).toBe('Frank Herbert');
    expect(contributors[0].did).toBe(SERVICE_DID);

    const join = db.select().from(schema.bookContributors).all();
    expect(join).toHaveLength(1);
    expect(join[0].bookUri).toBe(mapped.uri);
    expect(join[0].contributorUri).toBe(contributors[0].uri);
    expect(join[0].roleUri).toMatch(/contributor\.type/);

    const role = db
      .select()
      .from(schema.contributorTypes)
      .where(eq(schema.contributorTypes.name, 'author'))
      .get();
    expect(role).toBeDefined();
    expect(join[0].roleUri).toBe(role!.uri);
  });

  it('reuses an existing contributor record by case-insensitive name match', async () => {
    const a = catalogBookToBookData(baseRecord(), { serviceDid: SERVICE_DID });
    await importBookhiveCatalogBook(db, a);

    const rec2 = baseRecord();
    rec2.id = 'aaaaBBBBccccdddd';
    rec2.authors = 'frank herbert';
    rec2.identifiers = { isbn13: '9999999999999' }; // avoid isbn-unique collision
    const b = catalogBookToBookData(rec2, { serviceDid: SERVICE_DID });
    await importBookhiveCatalogBook(db, b);

    const contributors = db.select().from(schema.contributors).all();
    expect(contributors).toHaveLength(1);
    expect(contributors[0].name).toBe('Frank Herbert');
  });

  it('creates one contributor per tab-separated author', async () => {
    const rec = baseRecord();
    rec.id = 'aaaabbbbccccdddd';
    rec.authors = 'Alice\tBob\tCarol';
    const mapped = catalogBookToBookData(rec, { serviceDid: SERVICE_DID });
    await importBookhiveCatalogBook(db, mapped);

    const contributors = db.select().from(schema.contributors).all();
    expect(contributors).toHaveLength(3);
    expect(contributors.map((c) => c.name).sort()).toEqual(['Alice', 'Bob', 'Carol']);

    const join = db.select().from(schema.bookContributors).all();
    expect(join).toHaveLength(3);
    const orders = join
      .map((j) => j.ordering)
      .sort((a: number | null, b: number | null) => (a ?? 0) - (b ?? 0));
    expect(orders).toEqual([0, 1, 2]);
  });

  it('upserts an existing book row when re-imported with the same hiveId', async () => {
    const mapped = catalogBookToBookData(baseRecord(), { serviceDid: SERVICE_DID });
    await importBookhiveCatalogBook(db, mapped);

    const rec = baseRecord();
    rec.title = 'Dune (Revised Edition)';
    rec.description = 'A new foreword.';
    const mapped2 = catalogBookToBookData(rec, { serviceDid: SERVICE_DID });
    expect(mapped2.uri).toBe(mapped.uri);

    await importBookhiveCatalogBook(db, mapped2);

    const rows = db.select().from(schema.books).where(eq(schema.books.uri, mapped.uri)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Dune (Revised Edition)');
    expect(rows[0].description).toBe('A new foreword.');
  });

  it('merges new identifiers on update', async () => {
    const rec = baseRecord();
    rec.identifiers = { isbn13: '9780441172719' };
    const mapped = catalogBookToBookData(rec, { serviceDid: SERVICE_DID });
    await importBookhiveCatalogBook(db, mapped);

    rec.identifiers = { isbn10: '0441172717', goodreadsId: 'X' };
    const mapped2 = catalogBookToBookData(rec, { serviceDid: SERVICE_DID });
    await importBookhiveCatalogBook(db, mapped2);

    const row = db.select().from(schema.books).where(eq(schema.books.uri, mapped.uri)).get();
    const types = (row!.identifiers as Array<{ type: string; value: string }>).map((i) => i.type).sort();
    expect(types).toEqual(['goodreadsId', 'hiveId', 'isbn10', 'isbn13']);
  });
});
