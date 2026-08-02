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
const _s = schema;
const _d = db as any;

import { setupFts, searchBooks } from './init.js';

function getSqlite() {
  return _d.$sqlite as import('better-sqlite3').default;
}

describe('db/init', () => {
  beforeEach(() => {
    const sqlite = getSqlite();
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .filter(t => !t.name.startsWith('sqlite_') && !t.name.startsWith('__drizzle'));
    for (const t of tables) {
      try { sqlite.prepare(`DELETE FROM "${t.name}"`).run(); } catch {}
    }
    sqlite.prepare('DROP TABLE IF EXISTS books_fts').run();
    sqlite.prepare('DROP TRIGGER IF EXISTS books_ai').run();
    sqlite.prepare('DROP TRIGGER IF EXISTS books_ad').run();
    sqlite.prepare('DROP TRIGGER IF EXISTS books_au').run();
    setupFts();
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
});
