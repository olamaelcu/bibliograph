import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, clearSqliteTables } from '../test-utils/db.js';
import { schema } from '../db/connection.js';
import {
  catalogBookToBookData,
  bookhiveUserBookToReadingStatus,
  type BookhiveCatalogRecord,
  type BookhiveUserBookRecord,
} from './mapper.js';
import { importBookhiveCatalogBook, importUserBookRecord } from './importer.js';
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

describe('importUserBookRecord', () => {
  const USER_DID = 'did:plc:reader1';

  function seedCatalogBook(hiveId: string = 'M5fR8aBcDeFgHiJkLmNoP'): string {
    const rec = baseRecord();
    rec.id = hiveId;
    rec.identifiers = { isbn13: `97804411727${hiveId.slice(-2)}`, isbn10: undefined as never, goodreadsId: undefined as never };
    const mapped = catalogBookToBookData(rec, { serviceDid: SERVICE_DID });
    importBookhiveCatalogBook(db, mapped);
    return mapped.uri;
  }

  const userBookRecord = (): BookhiveUserBookRecord => ({
    $type: 'buzz.bookhive.book',
    title: 'Dune',
    authors: 'Frank Herbert',
    hiveId: 'M5fR8aBcDeFgHiJkLmNoP',
    status: 'buzz.bookhive.defs#finished',
    stars: 8,
    review: 'A masterpiece of worldbuilding.',
    bookProgress: { percent: 100, currentPage: 412, totalPages: 412, updatedAt: '2026-02-20T18:30:00.000Z' },
    startedAt: '2026-01-10T00:00:00.000Z',
    finishedAt: '2026-02-20T18:30:00.000Z',
    createdAt: '2026-01-10T00:00:00.000Z',
  });

  const SOURCE_URI =
    'at://did:plc:reader1/buzz.bookhive.book/3jx5fabc7defghj';

  it('inserts a reading_statuses row for a known book, with review mirror', async () => {
    const bookUri = seedCatalogBook();
    const mapped = bookhiveUserBookToReadingStatus(userBookRecord(), { userDid: USER_DID });

    const result = importUserBookRecord(db, mapped, { sourceUri: SOURCE_URI });
    expect(result.action).toBe('inserted');

    const statuses = db.select().from(schema.readingStatuses).all();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].did).toBe(USER_DID);
    expect(statuses[0].bookUri).toBe(bookUri);
    expect(statuses[0].status).toBe('read');
    expect(statuses[0].rating).toBe(4);
    expect(statuses[0].progress).toBe(100);
    expect(statuses[0].startedAt).toBe('2026-01-10T00:00:00.000Z');
    expect(statuses[0].finishedAt).toBe('2026-02-20T18:30:00.000Z');
    expect(statuses[0].bookProgress).toEqual({
      percent: 100,
      currentPage: 412,
      totalPages: 412,
      updatedAt: '2026-02-20T18:30:00.000Z',
    });

    const reviews = db.select().from(schema.reviews).all();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].bookUri).toBe(bookUri);
    expect(reviews[0].did).toBe(USER_DID);
    expect(reviews[0].text).toBe('A masterpiece of worldbuilding.');
    expect(reviews[0].rating).toBe(4);
  });

  it('skips when the book is not known to Bibliograph', async () => {
    const rec = userBookRecord();
    rec.hiveId = 'UNKNOWNHIVEID01';
    const mapped = bookhiveUserBookToReadingStatus(rec, { userDid: USER_DID });

    const result = importUserBookRecord(db, mapped, { sourceUri: SOURCE_URI });
    expect(result.action).toBe('skipped');
    expect(db.select().from(schema.readingStatuses).all()).toHaveLength(0);
    expect(db.select().from(schema.reviews).all()).toHaveLength(0);
  });

  it('updates in place when the same user re-imports the same book', async () => {
    seedCatalogBook();
    const first = bookhiveUserBookToReadingStatus(userBookRecord(), { userDid: USER_DID });
    importUserBookRecord(db, first, { sourceUri: SOURCE_URI });

    const rec = userBookRecord();
    rec.status = 'buzz.bookhive.defs#reading';
    rec.stars = 5;
    rec.review = 'Re-reading for the fourth time.';
    rec.bookProgress = { percent: 42, currentPage: 173, totalPages: 412, updatedAt: '2026-01-15T00:00:00.000Z' };
    const second = bookhiveUserBookToReadingStatus(rec, { userDid: USER_DID });

    const result = importUserBookRecord(db, second, { sourceUri: SOURCE_URI });
    expect(result.action).toBe('updated');

    const statuses = db.select().from(schema.readingStatuses).all();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe('reading');
    expect(statuses[0].rating).toBe(3);
    expect(statuses[0].progress).toBe(42);

    const reviews = db.select().from(schema.reviews).all();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].text).toBe('Re-reading for the fourth time.');
  });

  it('creates a deterministic status uri from the source uri', async () => {
    seedCatalogBook();
    const mapped = bookhiveUserBookToReadingStatus(userBookRecord(), { userDid: USER_DID });
    importUserBookRecord(db, mapped, { sourceUri: SOURCE_URI });

    const status = db.select().from(schema.readingStatuses).get();
    expect(status!.uri).toMatch(/^at:\/\/[^/]+\/community\.lexicon\.book\.status\/[a-z0-9]{13}$/);

    // re-import with same source uri lands on the same row
    const mapped2 = bookhiveUserBookToReadingStatus(userBookRecord(), { userDid: USER_DID });
    const result = importUserBookRecord(db, mapped2, { sourceUri: SOURCE_URI });
    expect(result.action).toBe('updated');
    expect(db.select().from(schema.readingStatuses).all()).toHaveLength(1);
  });
});
