import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, clearAllTables } from './test-utils/db.js';
import { computeDeduplicationHash } from './dedup.js';
import { populateAllHashes, analyzeDuplicates, updateBookHash, getStats } from './dedup-detection.js';
import { mergeDuplicates } from './dedup-merge.js';

describe('computeDeduplicationHash', () => {
  it('produces consistent hashes for same inputs', () => {
    const a = computeDeduplicationHash('The Hobbit', 'J.R.R. Tolkien');
    const b = computeDeduplicationHash('The Hobbit', 'J.R.R. Tolkien');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('strips leading articles', () => {
    const withThe = computeDeduplicationHash('The Great Gatsby', 'Fitzgerald');
    const withoutThe = computeDeduplicationHash('Great Gatsby', 'Fitzgerald');
    expect(withThe).toBe(withoutThe);
  });

  it('is case insensitive', () => {
    const lower = computeDeduplicationHash('moby dick', 'herman melville');
    const upper = computeDeduplicationHash('MOBY DICK', 'HERMAN MELVILLE');
    expect(lower).toBe(upper);
  });

  it('ignores special characters and normalizes', () => {
    const a = computeDeduplicationHash('Moby-Dick!', 'Herman Melville');
    const b = computeDeduplicationHash('Moby-Dick!', 'Herman Melville');
    expect(a).toBe(b);
  });

  it('collapses whitespace', () => {
    const a = computeDeduplicationHash('Moby   Dick', 'Herman   Melville');
    const b = computeDeduplicationHash('Moby Dick', 'Herman Melville');
    expect(a).toBe(b);
  });

  it('differs for different titles', () => {
    const a = computeDeduplicationHash('Moby Dick', 'Herman Melville');
    const b = computeDeduplicationHash('Typee', 'Herman Melville');
    expect(a).not.toBe(b);
  });

  it('differs for different authors', () => {
    const a = computeDeduplicationHash('Moby Dick', 'Herman Melville');
    const b = computeDeduplicationHash('Moby Dick', 'Nathaniel Hawthorne');
    expect(a).not.toBe(b);
  });

  it('includes publication year when provided', () => {
    const a = computeDeduplicationHash('Dune', 'Frank Herbert', '1965-08-01');
    const b = computeDeduplicationHash('Dune', 'Frank Herbert', '1965');
    expect(a).toBe(b);
  });

  it('differs with different publication years', () => {
    const a = computeDeduplicationHash('Dune', 'Frank Herbert', '1965');
    const b = computeDeduplicationHash('Dune', 'Frank Herbert', '1984');
    expect(a).not.toBe(b);
  });
});

describe('dedup-detection', () => {
  const { db, schema } = createTestDb();

  beforeEach(() => {
    clearAllTables(db);
  });

  function seedBook(overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    const uri = (overrides.uri as string) ||
      `at://did:plc:test/community.lexicon.book.book/${Math.random().toString(36).slice(2, 15)}`;
    db.insert(schema.books)
      .values({
        uri,
        did: 'did:plc:test',
        title: (overrides.title as string) || 'Test Book',
        author: (overrides.author as string) || 'Test Author',
        status: 'active',
        createdAt: (overrides.createdAt as string) || now,
        updatedAt: now,
      } as typeof schema.books.$inferInsert)
      .run();
    return uri;
  }

  describe('analyzeDuplicates', () => {
    it('returns empty when no duplicates', async () => {
      seedBook({ title: 'Book A', author: 'Author 1' });
      seedBook({ title: 'Book B', author: 'Author 2' });

      const analysis = await analyzeDuplicates(db);
      expect(analysis.duplicateGroups).toBe(0);
    });

    it('detects duplicates with same title and author', async () => {
      seedBook({ title: 'Moby Dick', author: 'Herman Melville' });
      seedBook({ title: 'Moby Dick', author: 'Herman Melville' });

      const analysis = await analyzeDuplicates(db);
      expect(analysis.duplicateGroups).toBe(1);
      expect(analysis.groups[0].books).toHaveLength(2);
      expect(analysis.groups[0].title).toBe('Moby Dick');
    });

    it('detects duplicates with only case differences', async () => {
      seedBook({ title: 'MOBY DICK', author: 'herman melville' });
      seedBook({ title: 'moby dick', author: 'HERMAN MELVILLE' });

      const analysis = await analyzeDuplicates(db);
      expect(analysis.duplicateGroups).toBe(1);
    });

    it('reports correct stats', async () => {
      seedBook({ title: 'Book A', author: 'Author 1' });
      seedBook({ title: 'Book A', author: 'Author 1' });
      seedBook({ title: 'Book A', author: 'Author 1' });
      seedBook({ title: 'Book B', author: 'Author 2' });

      const analysis = await analyzeDuplicates(db);
      expect(analysis.totalBooks).toBe(4);
      expect(analysis.duplicateGroups).toBe(1);
      expect(analysis.groups[0].books).toHaveLength(3);
    });
  });

  describe('populateAllHashes', () => {
    it('fills deduplication_hash for all books', async () => {
      seedBook({ title: 'Book A', author: 'Author 1' });
      seedBook({ title: 'Book B', author: 'Author 2' });

      const result = await populateAllHashes(db);
      expect(result.updated).toBe(2);

      const books = await db.select().from(schema.books).all();
      for (const book of books) {
        expect(book.deduplicationHash).toBeTruthy();
        expect(book.deduplicationHash).toHaveLength(16);
      }
    });
  });

  describe('updateBookHash', () => {
    it('sets hash on a specific book', async () => {
      const uri = seedBook({ title: 'Test', author: 'Author' });

      const hash = await updateBookHash(db, uri);
      expect(hash).toBeTruthy();
      expect(hash).toHaveLength(16);

      const book = await db.query.books.findFirst({ where: eq(schema.books.uri, uri) });
      expect(book?.deduplicationHash).toBe(hash);
    });

    it('returns null for missing book', async () => {
      const hash = await updateBookHash(db, 'nonexistent');
      expect(hash).toBeNull();
    });
  });

  describe('getStats', () => {
    it('returns deduplication statistics', async () => {
      seedBook({ title: 'Book A', author: 'Author 1' });
      seedBook({ title: 'Book A', author: 'Author 1' });
      seedBook({ title: 'Book B', author: 'Author 2' });

      await populateAllHashes(db);
      const stats = await getStats(db);

      expect(stats.totalBooks).toBe(3);
      expect(stats.hashPopulated).toBe(3);
      expect(stats.duplicateGroups).toBe(1);
    });
  });
});

describe('dedup-merge', () => {
  const { db, schema } = createTestDb();

  beforeEach(() => {
    clearAllTables(db);
  });

  function seedBook(overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    const uri = (overrides.uri as string) ||
      `at://did:plc:test/community.lexicon.book.book/${Math.random().toString(36).slice(2, 15)}`;
    db.insert(schema.books)
      .values({
        uri,
        did: 'did:plc:test',
        title: (overrides.title as string) || 'Test Book',
        author: (overrides.author as string) || 'Test Author',
        isbn: overrides.isbn as string | undefined,
        publishedDate: overrides.publishedDate as string | undefined,
        description: overrides.description as string | undefined,
        pageCount: overrides.pageCount as number | undefined,
        identifiers: (overrides.identifiers as Array<{ type: string; value: string }>) || [],
        coverUrl: overrides.coverUrl as string | undefined,
        status: 'active',
        deduplicationHash: overrides.deduplicationHash as string | undefined,
        createdAt: (overrides.createdAt as string) || now,
        updatedAt: now,
      } as typeof schema.books.$inferInsert)
      .run();
    return uri;
  }

  function seedStatus(bookUri: string) {
    const now = new Date().toISOString();
    db.insert(schema.readingStatuses)
      .values({
        uri: `at://did:plc:test/status/${Math.random().toString(36).slice(2, 15)}`,
        did: 'did:plc:test',
        bookUri,
        status: 'reading',
        bookTitle: 'Test Book',
        bookAuthor: 'Test Author',
        createdAt: now,
      } as typeof schema.readingStatuses.$inferInsert)
      .run();
  }

  function bookCount(): number {
    return db.select().from(schema.books).all().length;
  }

  describe('dry run', () => {
    it('does not delete books in dry run mode', async () => {
      const older = new Date('2024-01-01').toISOString();
      const newer = new Date('2025-01-01').toISOString();

      seedBook({
        title: 'Moby Dick',
        author: 'Herman Melville',
        identifiers: [{ type: 'openlibrary', value: '/works/OL1' }],
        createdAt: older,
      });
      seedBook({
        title: 'Moby Dick',
        author: 'Herman Melville',
        identifiers: [{ type: 'openlibrary', value: '/works/OL2' }],
        createdAt: newer,
      });

      expect(bookCount()).toBe(2);

      const result = await mergeDuplicates(db, true);

      expect(result.merged).toBe(1);
      expect(bookCount()).toBe(2);
    });
  });

  describe('actual merge', () => {
    it('keeps the newest book and merges identifiers', async () => {
      const older = new Date('2024-01-01').toISOString();
      const newer = new Date('2025-01-01').toISOString();

      const uriOld = seedBook({
        title: 'Moby Dick',
        author: 'Herman Melville',
        identifiers: [{ type: 'openlibrary', value: '/works/OL1' }],
        createdAt: older,
      });
      const uriNew = seedBook({
        title: 'Moby Dick',
        author: 'Herman Melville',
        identifiers: [{ type: 'openlibrary', value: '/works/OL2' }, { type: 'googlebooks', value: 'gb1' }],
        createdAt: newer,
      });

      const result = await mergeDuplicates(db, false);

      expect(result.merged).toBe(1);
      expect(result.deleted).toBe(1);
      expect(bookCount()).toBe(1);

      const remaining = await db.query.books.findFirst({ where: eq(schema.books.uri, uriNew) });
      expect(remaining).toBeTruthy();

      const oldBook = await db.query.books.findFirst({ where: eq(schema.books.uri, uriOld) });
      expect(oldBook).toBeFalsy();
    });

    it('updates foreign key references from deleted books', async () => {
      const older = new Date('2024-01-01').toISOString();
      const newer = new Date('2025-01-01').toISOString();

      const uriOld = seedBook({
        title: 'Moby Dick',
        author: 'Herman Melville',
        identifiers: [{ type: 'openlibrary', value: '/works/OL1' }],
        createdAt: older,
      });
      const uriNew = seedBook({
        title: 'Moby Dick',
        author: 'Herman Melville',
        identifiers: [{ type: 'openlibrary', value: '/works/OL2' }],
        createdAt: newer,
      });

      seedStatus(uriOld);

      await mergeDuplicates(db, false);

      const statuses = await db.select().from(schema.readingStatuses).all();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].bookUri).toBe(uriNew);
    });
  });

  describe('identifier merging', () => {
    it('deduplicates identifiers', async () => {
      const older = new Date('2024-01-01').toISOString();
      const newer = new Date('2025-01-01').toISOString();

      seedBook({
        title: 'Dune',
        author: 'Frank Herbert',
        identifiers: [{ type: 'openlibrary', value: '/works/OL1' }],
        createdAt: older,
      });
      seedBook({
        title: 'Dune',
        author: 'Frank Herbert',
        identifiers: [{ type: 'openlibrary', value: '/works/OL1' }, { type: 'isbn', value: '978123' }],
        createdAt: newer,
      });

      await mergeDuplicates(db, false);

      const remaining = await db.select().from(schema.books).all();
      expect(remaining).toHaveLength(1);
      const ids = remaining[0].identifiers as Array<{ type: string; value: string }>;
      expect(ids).toEqual([
        { type: 'openlibrary', value: '/works/OL1' },
        { type: 'isbn', value: '978123' },
      ]);
    });
  });
});
