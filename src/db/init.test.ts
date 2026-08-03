import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('./schema.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  (db as any).$sqlite = sqlite;
  return { db, schema };
});

import { db, schema } from './connection.js';
import { clearSqliteTables } from '../test-utils/db.js';
const _s = schema;
const _d = db as any;

import { setupFts, setupIdentifiersView, searchBooks } from './init.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

describe('db/init', () => {
  beforeEach(() => {
    const sqlite = getSqlite();
    clearSqliteTables(sqlite);
    sqlite.prepare('DROP TABLE IF EXISTS books_fts').run();
    sqlite.prepare('DROP TRIGGER IF EXISTS books_ai').run();
    sqlite.prepare('DROP TRIGGER IF EXISTS books_ad').run();
    sqlite.prepare('DROP TRIGGER IF EXISTS books_au').run();
    sqlite.prepare('DROP VIEW IF EXISTS books_identifiers').run();
    setupFts();
    setupIdentifiersView();
  });

  describe('setupFts', () => {
    it('creates the FTS virtual table', () => {
      const result = getSqlite().prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='books_fts'",
      ).all();
      expect(result).toHaveLength(1);
    });

    it('creates the AFTER INSERT trigger', () => {
      const result = getSqlite().prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='books_ai'",
      ).all();
      expect(result).toHaveLength(1);
    });

    it('creates the AFTER DELETE trigger', () => {
      const result = getSqlite().prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='books_ad'",
      ).all();
      expect(result).toHaveLength(1);
    });

    it('creates the AFTER UPDATE trigger', () => {
      const result = getSqlite().prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='books_au'",
      ).all();
      expect(result).toHaveLength(1);
    });
  });

  describe('searchBooks', () => {
    it('returns matching books by title', () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:author/book/moby',
        did: 'did:plc:author',
        title: 'Moby Dick',
        author: 'Herman Melville',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const results = searchBooks('Moby');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Moby Dick');
    });

    it('returns matching books by author', () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:author/book/melville',
        did: 'did:plc:author',
        title: 'Typee',
        author: 'Herman Melville',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const results = searchBooks('Melville');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Typee');
    });

    it('strips quotes from query', () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:author/book/test',
        did: 'did:plc:author',
        title: 'Test Book',
        author: 'Author',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const results = searchBooks('"Test Book"');
      expect(results).toHaveLength(1);
    });

    it('handles multi-word queries with AND logic', () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:author/book/hp',
        did: 'did:plc:author',
        title: 'Harry Potter',
        author: 'J.K. Rowling',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const results = searchBooks('Harry Potter');
      expect(results).toHaveLength(1);
    });

    it('returns empty array when no match', () => {
      const results = searchBooks('NonexistentBookXYZ');
      expect(results).toEqual([]);
    });
  });

  describe('setupIdentifiersView', () => {
    it('creates the books_identifiers view', () => {
      const result = getSqlite().prepare(
        "SELECT name FROM sqlite_master WHERE type='view' AND name='books_identifiers'",
      ).all();
      expect(result).toHaveLength(1);
    });

    it('exposes JSON identifiers in the view', () => {
      getSqlite().prepare(
        `INSERT INTO books (uri, did, title, author, identifiers, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        'at://did:plc:a/book/view-test',
        'did:plc:a',
        'View Test Book',
        'View Author',
        JSON.stringify([
          { type: 'oclc', value: '987654321' },
          { type: 'asin', value: 'B00VIEWTEST' },
        ]),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      const rows = getSqlite().prepare(
        `SELECT * FROM books_identifiers WHERE uri = ? AND claim_status = 'json'`,
      ).all('at://did:plc:a/book/view-test');

      expect(rows).toHaveLength(2);
      expect((rows as any)[0].identifier_type).toBe('oclc');
      expect((rows as any)[0].identifier_value).toBe('987654321');
      expect((rows as any)[1].identifier_type).toBe('asin');
      expect((rows as any)[1].identifier_value).toBe('B00VIEWTEST');
    });

    it('exposes verified claims in the view', () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/claimed-view',
        did: 'did:plc:a',
        title: 'Claimed View Book',
        author: 'View Author',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      db.insert(_s.claims).values({
        uri: 'at://did:plc:a/claim/view-1',
        did: 'did:plc:a',
        bookUri: 'at://did:plc:a/book/claimed-view',
        identifier: '9780123456789',
        identifierType: 'isbn',
        claimedBy: 'did:plc:a',
        status: 'verified',
        createdAt: new Date().toISOString(),
      }).run();

      const rows = getSqlite().prepare(
        `SELECT * FROM books_identifiers WHERE uri = ? AND claim_status = 'verified'`,
      ).all('at://did:plc:a/book/claimed-view');

      expect(rows).toHaveLength(1);
      expect((rows as any)[0].identifier_type).toBe('isbn');
      expect((rows as any)[0].identifier_value).toBe('9780123456789');
    });
  });

  describe('reading status uniqueness', () => {
    it('enforces one reading status per user and book', () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/unique',
        did: 'did:plc:a',
        title: 'Unique Book',
        author: 'Unique Author',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const now = new Date().toISOString();
      db.insert(_s.readingStatuses).values({
        uri: 'at://did:plc:a/status/1',
        did: 'did:plc:a',
        bookUri: 'at://did:plc:a/book/unique',
        status: 'reading',
        bookTitle: 'Unique Book',
        bookAuthor: 'Unique Author',
        createdAt: now,
      }).run();

      expect(() => {
        db.insert(_s.readingStatuses).values({
          uri: 'at://did:plc:a/status/2',
          did: 'did:plc:a',
          bookUri: 'at://did:plc:a/book/unique',
          status: 'read',
          bookTitle: 'Unique Book',
          bookAuthor: 'Unique Author',
          createdAt: now,
        }).run();
      }).toThrow();
    });

    it('allows a different user to status the same book', () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/shared',
        did: 'did:plc:a',
        title: 'Shared Book',
        author: 'Shared Author',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const now = new Date().toISOString();
      db.insert(_s.readingStatuses).values({
        uri: 'at://did:plc:a/status/1',
        did: 'did:plc:a',
        bookUri: 'at://did:plc:a/book/shared',
        status: 'reading',
        bookTitle: 'Shared Book',
        bookAuthor: 'Shared Author',
        createdAt: now,
      }).run();
      db.insert(_s.readingStatuses).values({
        uri: 'at://did:plc:b/status/1',
        did: 'did:plc:b',
        bookUri: 'at://did:plc:a/book/shared',
        status: 'read',
        bookTitle: 'Shared Book',
        bookAuthor: 'Shared Author',
        createdAt: now,
      }).run();

      const rows = db.select().from(_s.readingStatuses).all();
      expect(rows).toHaveLength(2);
    });
  });
});
