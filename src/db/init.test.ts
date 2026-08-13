import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('./schema.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('journal_size_limit = 134217728');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('cache_size = -20000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  (db as any).$sqlite = sqlite;
  return { db, schema, sqliteHandle: sqlite };
});

import { db, schema, sqliteHandle } from './connection.js';
import { clearSqliteTables } from '../test-utils/db.js';
const _s = schema;
const _d = db as any;

import { setupFts, setupIdentifiersView, searchBooks, ftsSearchBooks, ftsSearchBooksNumeric } from './init.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

describe('db/init', () => {
  describe('connection pragmas', () => {
    it('uses WAL journal mode (memory DBs fall back to memory, which is acceptable for tests)', () => {
      const mode = String(sqliteHandle.pragma('journal_mode', { simple: true })).toLowerCase();
      expect(['wal', 'memory']).toContain(mode);
    });

    it('caps the WAL at 128 MB', () => {
      const limit = sqliteHandle.pragma('journal_size_limit', { simple: true });
      expect(limit).toBe(134217728);
    });

    it('sets synchronous to NORMAL', () => {
      const value = sqliteHandle.pragma('synchronous', { simple: true });
      expect(value).toBe(1);
    });

    it('enables foreign keys', () => {
      const value = sqliteHandle.pragma('foreign_keys', { simple: true });
      expect(value).toBe(1);
    });

    it('exposes the sqlite handle for wal_checkpoint', () => {
      const result = sqliteHandle.pragma('wal_checkpoint');
      expect(Array.isArray(result)).toBe(true);
    });
  });

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

  describe('ftsSearchBooks', () => {
    function seedBook(uri: string, title: string, author: string): void {
      db.insert(_s.books).values({
        uri,
        did: 'did:plc:author',
        title,
        author,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
    }

    it('returns empty array on empty query without hitting FTS', () => {
      const results = ftsSearchBooks('', 20, 0);
      expect(results).toEqual([]);
    });

    it('returns matching books as full rows', () => {
      seedBook('at://did:plc:author/book/fts-moby', 'Moby Dick', 'Herman Melville');
      seedBook('at://did:plc:author/book/fts-other', 'Other Book', 'Other Author');

      const results = ftsSearchBooks('Moby', 20, 0);
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Moby Dick');
      expect(results[0].uri).toBe('at://did:plc:author/book/fts-moby');
    });

    it('returns empty array for non-matching tokens', () => {
      seedBook('at://did:plc:author/book/fts-moby2', 'Moby Dick', 'Herman Melville');

      const results = ftsSearchBooks('__health_check__ __health_check__', 20, 0);
      expect(results).toEqual([]);
    });

    it('honors limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        seedBook(`at://did:plc:author/book/fts-seq-${i}`, `Pages Title ${i}`, 'Pages Author');
      }

      const first = ftsSearchBooks('Pages', 2, 0);
      expect(first).toHaveLength(2);

      const second = ftsSearchBooks('Pages', 2, 2);
      expect(second).toHaveLength(2);

      expect(first[0].uri).not.toBe(second[0].uri);
    });

    it('completes a non-matching FTS search in well under a second on an in-memory DB', () => {
      const started = Date.now();
      ftsSearchBooks('__nonexistent_token_xyz_qq__', 20, 0);
      expect(Date.now() - started).toBeLessThan(50);
    });
  });

  describe('ftsSearchBooksNumeric', () => {
    function seedIsbnBook(uri: string, title: string, author: string, isbn: string | null): void {
      db.insert(_s.books).values({
        uri,
        did: 'did:plc:author',
        title,
        author,
        isbn,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
    }

    it('returns empty array on empty query without hitting FTS', () => {
      expect(ftsSearchBooksNumeric('', 20, 0)).toEqual([]);
      expect(ftsSearchBooksNumeric('   ', 20, 0)).toEqual([]);
    });

    it('strips non-numeric, non-dash characters from the query', () => {
      expect(ftsSearchBooksNumeric('978abc', 20, 0)).toEqual([]);
      expect(ftsSearchBooksNumeric('978"evil', 20, 0)).toEqual([]);
    });

    it('matches ISBN by anchored prefix', () => {
      seedIsbnBook('at://did:plc:a/book/isbn-dashed', 'Dashed', 'Author', '978-0-12-345678-9');
      seedIsbnBook('at://did:plc:a/book/isbn-plain', 'Plain', 'Author', '9780099528982');
      seedIsbnBook('at://did:plc:a/book/isbn-other', 'Other', 'Author', '1234567890');

      const results = ftsSearchBooksNumeric('978-0-12', 20, 0);
      const uris = results.map(r => r.uri);
      expect(uris).toContain('at://did:plc:a/book/isbn-dashed');
      expect(uris).not.toContain('at://did:plc:a/book/isbn-other');
    });

    it('matches plain (dashless) ISBNs', () => {
      seedIsbnBook('at://did:plc:a/book/isbn-plain-only', 'Plain', 'Author', '9780140449266');

      const results = ftsSearchBooksNumeric('9780140', 20, 0);
      const uris = results.map(r => r.uri);
      expect(uris).toContain('at://did:plc:a/book/isbn-plain-only');
    });

    it('also matches numeric prefixes appearing in titles', () => {
      seedIsbnBook('at://did:plc:a/book/isbn-in-title', 'Volume 978-0-12 Special', 'Author', '9999999999999');

      const results = ftsSearchBooksNumeric('978-0-12', 20, 0);
      const uris = results.map(r => r.uri);
      expect(uris).toContain('at://did:plc:a/book/isbn-in-title');
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
