import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../db/schema.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  (db as any).$sqlite = sqlite;
  return { db, schema };
});

vi.mock('../auth.js', async () => {
  return {
    requireAuth: vi.fn().mockResolvedValue('did:plc:test'),
    canCreateBook: vi.fn().mockResolvedValue(true),
    canEditBook: vi.fn().mockResolvedValue(true),
    canClaimBook: vi.fn().mockResolvedValue(true),
    isLibrarian: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../labeler.js', async () => {
  const actual = await import('../labeler.js');
  return {
    ...actual,
    publishLabel: vi.fn(),
    negateLabel: vi.fn(),
  };
});

import { db, schema } from '../db/connection.js';
const _s = schema;
const _d = db as any;

import { requireAuth, canCreateBook, isLibrarian } from '../auth.js';

import {
  createBook, createReview, createStatus, createClaim,
  verifyClaim, appointLibrarian, revokeLibrarian,
  createShelf, addToShelf, removeFromShelf,
} from './create-book.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

function clearTables() {
  const sqlite = getSqlite();
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .filter(t => !t.name.startsWith('sqlite_') && !t.name.startsWith('__drizzle'));
  for (const t of tables) {
    try { sqlite.prepare(`DELETE FROM "${t.name}"`).run(); } catch {}
  }
}

function mockContext(overrides: {
  jsonBody?: unknown;
} = {}) {
  const store = new Map<string, unknown>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  store.set('log', log);

  const headers = new Headers({ authorization: 'Bearer test-token' });

  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    req: {
      query: () => ({}),
      queries: () => undefined,
      json: () => Promise.resolve(overrides.jsonBody),
      raw: { headers },
    },
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as any;
}

async function readJson(res: Response) {
  return JSON.parse(await res.text());
}

describe('api/create-book', () => {
  beforeEach(() => {
    clearTables();
    vi.clearAllMocks();
    (requireAuth as any).mockResolvedValue('did:plc:test');
    (canCreateBook as any).mockResolvedValue(true);
  });

  describe('createBook', () => {
    it('returns 400 when title is missing', async () => {
      const c = mockContext({ jsonBody: { author: 'Test', isbn: '9780000000001' } });
      const res = await createBook(c);
      expect(res.status).toBe(400);
    });

    it('returns 400 when author is missing', async () => {
      const c = mockContext({ jsonBody: { title: 'Test', isbn: '9780000000001' } });
      const res = await createBook(c);
      expect(res.status).toBe(400);
    });

    it('returns 400 when isbn is missing', async () => {
      const c = mockContext({ jsonBody: { title: 'Test', author: 'Author' } });
      const res = await createBook(c);
      expect(res.status).toBe(400);
    });

    it('returns 403 when user cannot create book', async () => {
      (canCreateBook as any).mockResolvedValue(false);
      const c = mockContext({ jsonBody: { title: 'Forbidden', author: 'Author', isbn: '9780000000001' } });
      const res = await createBook(c);
      expect(res.status).toBe(403);
    });

    it('returns 409 when isbn already exists', async () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:other/book/existing',
        did: 'did:plc:other',
        title: 'Existing Book',
        author: 'Other Author',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ jsonBody: { title: 'Dup', author: 'Author', isbn: '9780000000001' } });
      const res = await createBook(c);
      expect(res.status).toBe(409);
    });

    it('creates a book and claim successfully', async () => {
      const c = mockContext({
        jsonBody: {
          title: 'New Book',
          author: 'New Author',
          isbn: '9780000000001',
          publishedDate: '2024-01-01',
          description: 'A test book',
          pageCount: 300,
          language: 'en',
          categories: ['fiction'],
          coverUrl: 'http://example.com/cover.jpg',
        },
      });
      const res = await createBook(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.uri).toMatch(/^at:\/\/did:plc:test\/community\.lexicon\.book\.book\//);
      expect(body.cid).toMatch(/^bafyrei-/);

      const books = db.select().from(_s.books).all();
      expect(books).toHaveLength(1);
      expect(books[0].title).toBe('New Book');

      const claims = db.select().from(_s.claims).all();
      expect(claims).toHaveLength(1);
    });
  });

  describe('createReview', () => {
    it('returns 400 when bookUri is missing', async () => {
      const c = mockContext({ jsonBody: { text: 'Nice' } });
      const res = await createReview(c);
      expect(res.status).toBe(400);
    });

    it('returns 400 when text is missing', async () => {
      const c = mockContext({ jsonBody: { bookUri: 'at://did:plc:a/book/1' } });
      const res = await createReview(c);
      expect(res.status).toBe(400);
    });

    it('returns 404 when book does not exist', async () => {
      const c = mockContext({ jsonBody: { bookUri: 'at://did:plc:nonexistent/book/99', text: 'Review' } });
      const res = await createReview(c);
      expect(res.status).toBe(404);
    });

    it('creates a review for an existing book', async () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/1',
        did: 'did:plc:a',
        title: 'Target Book',
        author: 'Target Author',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const c = mockContext({
        jsonBody: { bookUri: 'at://did:plc:a/book/1', text: 'Amazing book!', rating: 5 },
      });
      const res = await createReview(c);
      expect(res.status).toBe(200);

      const reviews = db.select().from(_s.reviews).all();
      expect(reviews).toHaveLength(1);
      expect(reviews[0].text).toBe('Amazing book!');
    });
  });

  describe('createStatus', () => {
    it('returns 400 when required fields missing', async () => {
      const c = mockContext({ jsonBody: {} });
      const res = await createStatus(c);
      expect(res.status).toBe(400);
    });

    it('returns 404 when book does not exist', async () => {
      const c = mockContext({ jsonBody: { bookUri: 'at://did:plc:unknown/book/99', status: 'reading' } });
      const res = await createStatus(c);
      expect(res.status).toBe(404);
    });

    it('creates a reading status', async () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/1',
        did: 'did:plc:a',
        title: 'Target Book',
        author: 'Target Author',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const c = mockContext({
        jsonBody: { bookUri: 'at://did:plc:a/book/1', status: 'reading', progress: 42, rating: 4 },
      });
      const res = await createStatus(c);
      expect(res.status).toBe(200);

      const statuses = db.select().from(_s.readingStatuses).all();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].status).toBe('reading');
    });
  });

  describe('createClaim', () => {
    it('returns 400 when required fields missing', async () => {
      const c = mockContext({ jsonBody: { bookUri: 'at://x' } });
      const res = await createClaim(c);
      expect(res.status).toBe(400);
    });

    it('returns 404 when book not found', async () => {
      const c = mockContext({
        jsonBody: { bookUri: 'at://did:plc:unknown/book/99', identifier: '978x', identifierType: 'isbn' },
      });
      const res = await createClaim(c);
      expect(res.status).toBe(404);
    });

    it('returns 409 when already claimed by different author', async () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:other/book/1',
        did: 'did:plc:other',
        title: 'Claimed Book',
        author: 'Other',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      db.insert(_s.claims).values({
        uri: 'at://did:plc:other/claim/1',
        did: 'did:plc:other',
        bookUri: 'at://did:plc:other/book/1',
        identifier: '9780000000001',
        identifierType: 'isbn',
        claimedBy: 'did:plc:other',
        status: 'verified',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({
        jsonBody: { bookUri: 'at://did:plc:other/book/1', identifier: '9780000000001', identifierType: 'isbn' },
      });
      const res = await createClaim(c);
      expect(res.status).toBe(409);
    });

    it('creates a claim successfully', async () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/1',
        did: 'did:plc:a',
        title: 'Claimable',
        author: 'Author',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const c = mockContext({
        jsonBody: { bookUri: 'at://did:plc:a/book/1', identifier: '9780000000001', identifierType: 'isbn' },
      });
      const res = await createClaim(c);
      expect(res.status).toBe(200);
    });
  });

  describe('verifyClaim', () => {
    beforeEach(() => {
      (isLibrarian as any).mockReturnValue(true);
    });

    it('returns 400 when claimUri missing', async () => {
      const c = mockContext({ jsonBody: {} });
      const res = await verifyClaim(c);
      expect(res.status).toBe(400);
    });

    it('returns 404 when claim not found', async () => {
      const c = mockContext({ jsonBody: { claimUri: 'at://did:plc:unknown/claim/99' } });
      const res = await verifyClaim(c);
      expect(res.status).toBe(404);
    });

    it('returns 409 when already verified', async () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/1',
        did: 'did:plc:a',
        title: 'Book',
        author: 'Author',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      db.insert(_s.claims).values({
        uri: 'at://did:plc:a/claim/1',
        did: 'did:plc:a',
        bookUri: 'at://did:plc:a/book/1',
        identifier: '9780000000001',
        identifierType: 'isbn',
        claimedBy: 'did:plc:a',
        status: 'verified',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ jsonBody: { claimUri: 'at://did:plc:a/claim/1' } });
      const res = await verifyClaim(c);
      expect(res.status).toBe(409);
    });

    it('verifies a claim and updates book status', async () => {
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/1',
        did: 'did:plc:a',
        title: 'Pending Book',
        author: 'Author',
        isbn: '9780000000001',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      db.insert(_s.claims).values({
        uri: 'at://did:plc:a/claim/1',
        did: 'did:plc:a',
        bookUri: 'at://did:plc:a/book/1',
        identifier: '9780000000001',
        identifierType: 'isbn',
        claimedBy: 'did:plc:a',
        status: 'pending',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ jsonBody: { claimUri: 'at://did:plc:a/claim/1' } });
      const res = await verifyClaim(c);
      expect(res.status).toBe(200);

      const claim = db.select().from(_s.claims).all()[0];
      expect(claim.status).toBe('verified');

      const book = db.select().from(_s.books).all()[0];
      expect(book.status).toBe('active');
    });
  });

  describe('appointLibrarian', () => {
    beforeEach(() => {
      (isLibrarian as any).mockReturnValue(true);
    });

    it('returns 400 when targetDid missing', async () => {
      const c = mockContext({ jsonBody: {} });
      const res = await appointLibrarian(c);
      expect(res.status).toBe(400);
    });

    it('appoints a librarian', async () => {
      const c = mockContext({ jsonBody: { targetDid: 'did:plc:newlib' } });
      const res = await appointLibrarian(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.librarian).toBe('did:plc:newlib');
    });
  });

  describe('revokeLibrarian', () => {
    beforeEach(() => {
      (isLibrarian as any).mockReturnValue(true);
    });

    it('returns 400 when targetDid missing', async () => {
      const c = mockContext({ jsonBody: {} });
      const res = await revokeLibrarian(c);
      expect(res.status).toBe(400);
    });

    it('revokes a librarian', async () => {
      const c = mockContext({ jsonBody: { targetDid: 'did:plc:oldlib' } });
      const res = await revokeLibrarian(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.librarian).toBe('did:plc:oldlib');
    });
  });

  describe('createShelf', () => {
    it('returns 400 when name is missing', async () => {
      const c = mockContext({ jsonBody: {} });
      const res = await createShelf(c);
      expect(res.status).toBe(400);
    });

    it('creates a shelf with metadata', async () => {
      const c = mockContext({
        jsonBody: {
          name: 'Sci-Fi Favorites',
          description: 'Top picks',
          metadata: { theme: 'scifi' },
          coverUrl: 'https://example.com/cover.jpg',
        },
      });
      const res = await createShelf(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.uri).toMatch(/^at:\/\/did:plc:test\/community\.lexicon\.book\.shelf\//);

      const rows = db.select().from(_s.shelves).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Sci-Fi Favorites');
      expect(rows[0].metadata).toEqual({ theme: 'scifi' });
      expect(rows[0].coverUrl).toBe('https://example.com/cover.jpg');
    });
  });

  describe('addToShelf', () => {
    function seedShelfOwner(uri = 'at://did:plc:test/community.lexicon.book.shelf/shf001', did = 'did:plc:test') {
      db.insert(_s.shelves).values({
        uri,
        did,
        name: 'Shelf',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
    }

    it('returns 400 when shelfUri or bookUri missing', async () => {
      const c = mockContext({ jsonBody: { shelfUri: 'at://x/shelf/1' } });
      const res = await addToShelf(c);
      expect(res.status).toBe(400);
    });

    it('returns 404 when shelf not found', async () => {
      const c = mockContext({
        jsonBody: { shelfUri: 'at://did:plc:unknown/shelf/1', bookUri: 'at://did:plc:a/book/1' },
      });
      const res = await addToShelf(c);
      expect(res.status).toBe(404);
    });

    it('returns 403 when not the shelf owner', async () => {
      seedShelfOwner('at://did:plc:other/community.lexicon.book.shelf/shf001', 'did:plc:other');
      const c = mockContext({
        jsonBody: { shelfUri: 'at://did:plc:other/community.lexicon.book.shelf/shf001', bookUri: 'at://did:plc:a/book/1' },
      });
      const res = await addToShelf(c);
      expect(res.status).toBe(403);
    });

    it('returns 404 when book not found', async () => {
      seedShelfOwner();
      const c = mockContext({
        jsonBody: { shelfUri: 'at://did:plc:test/community.lexicon.book.shelf/shf001', bookUri: 'at://did:plc:unknown/book/99' },
      });
      const res = await addToShelf(c);
      expect(res.status).toBe(404);
    });

    it('returns 409 when book already on shelf', async () => {
      seedShelfOwner();
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/1',
        did: 'did:plc:a',
        title: 'Book',
        author: 'Author',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
      db.insert(_s.shelfItems).values({
        uri: 'at://did:plc:test/community.lexicon.book.shelfItem/sii001',
        did: 'did:plc:test',
        shelfUri: 'at://did:plc:test/community.lexicon.book.shelf/shf001',
        bookUri: 'at://did:plc:a/book/1',
        bookTitle: 'Book',
        bookAuthor: 'Author',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({
        jsonBody: { shelfUri: 'at://did:plc:test/community.lexicon.book.shelf/shf001', bookUri: 'at://did:plc:a/book/1' },
      });
      const res = await addToShelf(c);
      expect(res.status).toBe(409);
    });

    it('adds a book to a shelf', async () => {
      seedShelfOwner();
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/1',
        did: 'did:plc:a',
        title: 'Book',
        author: 'Author',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const c = mockContext({
        jsonBody: { shelfUri: 'at://did:plc:test/community.lexicon.book.shelf/shf001', bookUri: 'at://did:plc:a/book/1', note: 'favorite' },
      });
      const res = await addToShelf(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.uri).toMatch(/^at:\/\/did:plc:test\/community\.lexicon\.book\.shelfItem\//);

      const rows = db.select().from(_s.shelfItems).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].bookTitle).toBe('Book');
      expect(rows[0].note).toBe('favorite');
    });
  });

  describe('removeFromShelf', () => {
    it('returns 400 when shelfUri or bookUri missing', async () => {
      const c = mockContext({ jsonBody: {} });
      const res = await removeFromShelf(c);
      expect(res.status).toBe(400);
    });

    it('returns 404 when shelf not found', async () => {
      const c = mockContext({
        jsonBody: { shelfUri: 'at://did:plc:unknown/shelf/1', bookUri: 'at://did:plc:a/book/1' },
      });
      const res = await removeFromShelf(c);
      expect(res.status).toBe(404);
    });

    it('returns 403 when not the shelf owner', async () => {
      db.insert(_s.shelves).values({
        uri: 'at://did:plc:other/community.lexicon.book.shelf/shf001',
        did: 'did:plc:other',
        name: 'Shelf',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
      const c = mockContext({
        jsonBody: { shelfUri: 'at://did:plc:other/community.lexicon.book.shelf/shf001', bookUri: 'at://did:plc:a/book/1' },
      });
      const res = await removeFromShelf(c);
      expect(res.status).toBe(403);
    });

    it('returns 404 when item not on shelf', async () => {
      db.insert(_s.shelves).values({
        uri: 'at://did:plc:test/community.lexicon.book.shelf/shf001',
        did: 'did:plc:test',
        name: 'Shelf',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
      const c = mockContext({
        jsonBody: { shelfUri: 'at://did:plc:test/community.lexicon.book.shelf/shf001', bookUri: 'at://did:plc:a/book/1' },
      });
      const res = await removeFromShelf(c);
      expect(res.status).toBe(404);
    });

    it('removes a book from a shelf', async () => {
      db.insert(_s.shelves).values({
        uri: 'at://did:plc:test/community.lexicon.book.shelf/shf001',
        did: 'did:plc:test',
        name: 'Shelf',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
      db.insert(_s.books).values({
        uri: 'at://did:plc:a/book/1',
        did: 'did:plc:a',
        title: 'Book',
        author: 'Author',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
      db.insert(_s.shelfItems).values({
        uri: 'at://did:plc:test/community.lexicon.book.shelfItem/sii001',
        did: 'did:plc:test',
        shelfUri: 'at://did:plc:test/community.lexicon.book.shelf/shf001',
        bookUri: 'at://did:plc:a/book/1',
        bookTitle: 'Book',
        bookAuthor: 'Author',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({
        jsonBody: { shelfUri: 'at://did:plc:test/community.lexicon.book.shelf/shf001', bookUri: 'at://did:plc:a/book/1' },
      });
      const res = await removeFromShelf(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.ok).toBe(true);

      const rows = db.select().from(_s.shelfItems).all();
      expect(rows).toHaveLength(0);
    });
  });
});
