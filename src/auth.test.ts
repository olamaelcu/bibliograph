import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db/connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('./db/schema.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  (db as any).$sqlite = sqlite;
  return { db, schema };
});

vi.mock('@atcute/xrpc-server/auth', () => {
  class FakeVerifier {
    async verifyRequest() {
      const ok = process.env.FAKE_JWT_OK === '1';
      if (!ok) throw new Error('bad token');
      return { issuer: 'did:plc:viewer' };
    }
  }
  return { ServiceJwtVerifier: FakeVerifier };
});

import { db, schema } from './db/connection.js';
import { clearSqliteTables } from './test-utils/db.js';
const _s = schema;
const _d = db as any;

import { canCreateBook, canClaimBook, isLibrarian, isAuthorOf, optionalAuth } from './auth.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

function clearTables() {
  clearSqliteTables(getSqlite());
}

function seedBook(uri: string, isbn: string) {
  db.insert(_s.books).values({
    uri,
    did: 'did:plc:author',
    title: 'Test Book',
    author: 'Test Author',
    isbn,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
}

function seedLabel(src: string, uri: string, val: string, neg = 0) {
  const sqlite = getSqlite();
  const now = new Date().toISOString();
  sqlite.prepare('INSERT OR REPLACE INTO book_labels (src, uri, val, cts, neg) VALUES (?, ?, ?, ?, ?)').run(src, uri, val, now, neg);
}

describe('auth', () => {
  beforeEach(() => {
    clearTables();
  });

  afterEach(() => {
    delete process.env.FAKE_JWT_OK;
  });

  describe('optionalAuth', () => {
    it('returns undefined when no authorization header is present', async () => {
      const headers = new Headers();
      const did = await optionalAuth(headers, 'community.lexicon.book.getFeed');
      expect(did).toBeUndefined();
    });

    it('returns the viewer DID for a valid bearer token', async () => {
      process.env.FAKE_JWT_OK = '1';
      const headers = new Headers({ authorization: 'Bearer fake.jwt.token' });
      const did = await optionalAuth(headers, 'community.lexicon.book.getFeed');
      expect(did).toBe('did:plc:viewer');
    });

    it('throws 401 for an invalid bearer token', async () => {
      const headers = new Headers({ authorization: 'Bearer fake.jwt.token' });
      await expect(optionalAuth(headers, 'community.lexicon.book.getFeed')).rejects.toMatchObject({
        status: 401,
        error: 'AuthenticationRequired',
      });
    });
  });


  describe('canCreateBook', () => {
    it('returns true when no verified claim exists for the ISBN', async () => {
      const result = await canCreateBook('did:plc:author', '9781234567890');
      expect(result).toBe(true);
    });

    it('returns true when a verified claim exists by the same DID', async () => {
      seedBook('at://did:plc:author/book/test', '9781234567890');
      db.insert(_s.claims).values({
        uri: 'at://did:plc:author/claim/1',
        did: 'did:plc:author',
        bookUri: 'at://did:plc:author/book/test',
        identifier: '9781234567890',
        identifierType: 'isbn',
        claimedBy: 'did:plc:author',
        status: 'verified',
        createdAt: new Date().toISOString(),
      }).run();

      const result = await canCreateBook('did:plc:author', '9781234567890');
      expect(result).toBe(true);
    });

    it('returns false when ISBN is verified by a different author', async () => {
      seedBook('at://did:plc:other/book/test', '9781234567890');
      db.insert(_s.claims).values({
        uri: 'at://did:plc:other/claim/1',
        did: 'did:plc:other',
        bookUri: 'at://did:plc:other/book/test',
        identifier: '9781234567890',
        identifierType: 'isbn',
        claimedBy: 'did:plc:other',
        status: 'verified',
        createdAt: new Date().toISOString(),
      }).run();

      const result = await canCreateBook('did:plc:author', '9781234567890');
      expect(result).toBe(false);
    });

    it('ignores pending claims', async () => {
      seedBook('at://did:plc:other/book/test', '9781234567890');
      db.insert(_s.claims).values({
        uri: 'at://did:plc:other/claim/1',
        did: 'did:plc:other',
        bookUri: 'at://did:plc:other/book/test',
        identifier: '9781234567890',
        identifierType: 'isbn',
        claimedBy: 'did:plc:other',
        status: 'pending',
        createdAt: new Date().toISOString(),
      }).run();

      const result = await canCreateBook('did:plc:author', '9781234567890');
      expect(result).toBe(true);
    });
  });

  describe('canClaimBook', () => {
    it('returns true when no claim exists for the book', async () => {
      seedBook('at://did:plc:author/book/test', '9781234567890');
      const result = await canClaimBook('did:plc:reader', 'at://did:plc:author/book/test');
      expect(result).toBe(true);
    });

    it('returns true for a librarian even if claims exist', async () => {
      seedBook('at://did:plc:author/book/test', '9781234567890');
      db.insert(_s.claims).values({
        uri: 'at://did:plc:author/claim/1',
        did: 'did:plc:author',
        bookUri: 'at://did:plc:author/book/test',
        identifier: '9781234567890',
        identifierType: 'isbn',
        claimedBy: 'did:plc:author',
        status: 'verified',
        createdAt: new Date().toISOString(),
      }).run();

      seedLabel('did:web:localhost', 'did:plc:librarian', 'book:librarian');

      const result = await canClaimBook('did:plc:librarian', 'at://did:plc:author/book/test');
      expect(result).toBe(true);
    });

    it('returns false for non-librarian when claim exists', async () => {
      seedBook('at://did:plc:author/book/test', '9781234567890');
      db.insert(_s.claims).values({
        uri: 'at://did:plc:author/claim/1',
        did: 'did:plc:author',
        bookUri: 'at://did:plc:author/book/test',
        identifier: '9781234567890',
        identifierType: 'isbn',
        claimedBy: 'did:plc:author',
        status: 'pending',
        createdAt: new Date().toISOString(),
      }).run();

      const result = await canClaimBook('did:plc:reader', 'at://did:plc:author/book/test');
      expect(result).toBe(false);
    });
  });

  describe('isLibrarian', () => {
    it('returns true for a labeled librarian', () => {
      seedLabel('did:web:localhost', 'did:plc:librarian', 'book:librarian');
      expect(isLibrarian('did:plc:librarian')).toBe(true);
    });

    it('returns false for an unlabeled user', () => {
      expect(isLibrarian('did:plc:reader')).toBe(false);
    });

    it('returns false when label is negated', () => {
      seedLabel('did:web:localhost', 'did:plc:librarian', 'book:librarian', 1);
      expect(isLibrarian('did:plc:librarian')).toBe(false);
    });
  });

  describe('isAuthorOf', () => {
    it('returns true when DID has an author label for the book URI', () => {
      seedBook('at://did:plc:author/book/test', '9781234567890');
      seedLabel('did:web:localhost', 'at://did:plc:author/book/test', 'book:author');
      expect(isAuthorOf('did:web:localhost', 'at://did:plc:author/book/test')).toBe(true);
    });

    it('returns false when no author label exists', () => {
      seedBook('at://did:plc:author/book/test', '9781234567890');
      expect(isAuthorOf('did:web:alice', 'at://did:plc:author/book/test')).toBe(false);
    });
  });
});
