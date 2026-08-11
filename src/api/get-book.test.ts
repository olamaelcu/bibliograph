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

vi.mock('./search-fallback.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    searchFallback: vi.fn(async () => ({ source: 'none' as const, books: [] })),
  };
});

import { db, schema } from '../db/connection.js';
import { clearSqliteTables } from '../test-utils/db.js';
import { searchFallback } from './search-fallback.js';
const _s = schema;
const _d = db as any;

import { getBook, getBooks, getReviews, getReview, getUserStatus, searchBooksHandler, listBooksHandler, getClaims, getLabelerLabels, getShelves, getShelf, getShelfItems } from './get-book.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

function clearTables() {
  clearSqliteTables(getSqlite());
}

function seedLabel(src: string, uri: string, val: string) {
  const sqlite = getSqlite();
  const now = new Date().toISOString();
  sqlite.prepare('INSERT OR REPLACE INTO book_labels (src, uri, val, cts, neg) VALUES (?, ?, ?, ?, 0)').run(src, uri, val, now);
}

function mockContext(overrides: {
  query?: Record<string, string>;
  queries?: Record<string, string[]>;
} = {}) {
  const store = new Map<string, unknown>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  store.set('log', log);

  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    req: {
      query: () => (overrides.query || {}),
      queries: (key: string) => overrides.queries?.[key],
    },
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    store,
  } as any;
}

async function readJson(res: Response) {
  return JSON.parse(await res.text());
}

function seedBook(overrides: Partial<typeof _s.books.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const uri = overrides.uri || 'at://did:plc:author/book/test001';
  db.insert(_s.books).values({
    uri,
    did: 'did:plc:author',
    title: 'Test Book',
    author: 'Test Author',
    isbn: '9781234567890',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
}

describe('api/get-book', () => {
  beforeEach(() => {
    clearTables();
  });

  describe('getBook', () => {
    it('returns 400 when uri is missing', async () => {
      const c = mockContext();
      const res = await getBook(c);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe('InvalidRequest');
    });

    it('returns 404 when book not found', async () => {
      const c = mockContext({ query: { uri: 'at://did:plc:unknown/book/missing' } });
      const res = await getBook(c);
      expect(res.status).toBe(404);
    });

    it('returns book when found', async () => {
      seedBook();
      const c = mockContext({ query: { uri: 'at://did:plc:author/book/test001' } });
      const res = await getBook(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.uri).toBe('at://did:plc:author/book/test001');
      expect(body.record.title).toBe('Test Book');
    });

    describe('external identifier lookup', () => {
      it('returns the book when the uri is an ISBN-13 (urn:isbn: form)', async () => {
        seedBook({ isbn: '9780441172719' });
        const c = mockContext({ query: { uri: 'urn:isbn:9780441172719' } });
        const res = await getBook(c);
        expect(res.status).toBe(200);
        const body = await readJson(res);
        expect(body.record.isbn).toBe('9780441172719');
      });

      it('returns the book when the uri is a bare ISBN-13', async () => {
        seedBook({ isbn: '9780441172719' });
        const c = mockContext({ query: { uri: '9780441172719' } });
        const res = await getBook(c);
        expect(res.status).toBe(200);
      });

      it('returns the book when the uri is a dashed ISBN-13', async () => {
        seedBook({ isbn: '9780441172719' });
        const c = mockContext({ query: { uri: '978-0-441-17271-9' } });
        const res = await getBook(c);
        expect(res.status).toBe(200);
      });

      it('returns the book when the uri is an OLID edition key', async () => {
        seedBook({
          identifiers: [{ type: 'openlibrary', value: '/books/OL1234567M' }],
        });
        const c = mockContext({ query: { uri: 'OL1234567M' } });
        const res = await getBook(c);
        expect(res.status).toBe(200);
        const body = await readJson(res);
        expect(body.record.identifiers).toEqual([
          { type: 'openlibrary', value: '/books/OL1234567M' },
        ]);
      });

      it('returns the book when the uri is an OLID path form', async () => {
        seedBook({
          identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
        });
        const c = mockContext({ query: { uri: '/works/OL50W' } });
        const res = await getBook(c);
        expect(res.status).toBe(200);
      });

      it('returns the book when the uri is a full openlibrary.org URL', async () => {
        seedBook({
          identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
        });
        const c = mockContext({
          query: { uri: 'https://openlibrary.org/works/OL50W' },
        });
        const res = await getBook(c);
        expect(res.status).toBe(200);
      });

      it('returns 409 MultipleChoices when an OLID work key resolves to multiple books', async () => {
        seedBook({
          uri: 'at://did:plc:a/community.lexicon.book.book/ed1',
          isbn: '9780000000001',
          identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
          createdAt: '2024-01-01T00:00:00.000Z',
        });
        seedBook({
          uri: 'at://did:plc:a/community.lexicon.book.book/ed2',
          isbn: '9780000000002',
          identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
          createdAt: '2024-02-01T00:00:00.000Z',
        });

        const c = mockContext({ query: { uri: 'OL50W' } });
        const res = await getBook(c);
        expect(res.status).toBe(409);
        const body = await readJson(res);
        expect(body.error).toBe('MultipleBooks');
        expect(body.identifier).toBe('OL50W');
        expect(body.candidates).toHaveLength(2);
        const candidateUris = body.candidates.map((c: { uri: string }) => c.uri);
        expect(candidateUris).toContain('at://did:plc:a/community.lexicon.book.book/ed1');
        expect(candidateUris).toContain('at://did:plc:a/community.lexicon.book.book/ed2');
      });

      it('returns 404 when an ISBN is not in the DB', async () => {
        seedBook({ isbn: '9780441172719' });
        const c = mockContext({ query: { uri: 'urn:isbn:9780000000000' } });
        const res = await getBook(c);
        expect(res.status).toBe(404);
      });

      it('returns 400 when the input is unparseable', async () => {
        seedBook();
        const c = mockContext({ query: { uri: 'not-a-valid-identifier' } });
        const res = await getBook(c);
        expect(res.status).toBe(400);
        const body = await readJson(res);
        expect(body.error).toBe('InvalidInput');
      });
    });
  });

  describe('getBooks', () => {
    it('returns 400 when uris is missing', async () => {
      const c = mockContext();
      const res = await getBooks(c);
      expect(res.status).toBe(400);
    });

    it('returns matching books', async () => {
      seedBook({ uri: 'at://did:plc:a/book/1', title: 'Book One' });
      seedBook({ uri: 'at://did:plc:a/book/2', title: 'Book Two', isbn: '9780000000002' });

      const c = mockContext({
        queries: { uris: ['at://did:plc:a/book/1', 'at://did:plc:a/book/2'] },
      });
      const res = await getBooks(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toHaveLength(2);
    });

    describe('external identifier lookup', () => {
      it('resolves a mix of AT-URIs and ISBNs', async () => {
        seedBook({ uri: 'at://did:plc:a/community.lexicon.book.book/x', title: 'X' });
        seedBook({ isbn: '9780441172719', title: 'Y' });

        const c = mockContext({
          queries: {
            uris: ['at://did:plc:a/community.lexicon.book.book/x', 'urn:isbn:9780441172719'],
          },
        });
        const res = await getBooks(c);
        expect(res.status).toBe(200);
        const body = await readJson(res);
        expect(body.books).toHaveLength(2);
        expect(body.notFound).toEqual([]);
      });

      it('includes inputs that did not resolve in notFound', async () => {
        seedBook({ uri: 'at://did:plc:a/community.lexicon.book.book/x' });

        const c = mockContext({
          queries: {
            uris: [
              'at://did:plc:a/community.lexicon.book.book/x',
              'urn:isbn:9780000000000',
              'OL9999999X',
            ],
          },
        });
        const res = await getBooks(c);
        expect(res.status).toBe(200);
        const body = await readJson(res);
        expect(body.books).toHaveLength(1);
        expect(body.notFound).toEqual(['urn:isbn:9780000000000', 'OL9999999X']);
      });

      it('collapses multi-match inputs to one book each and reports the count', async () => {
        seedBook({
          uri: 'at://did:plc:a/community.lexicon.book.book/ed1',
          isbn: '9780000000001',
          title: 'Dune (1)',
          identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
        });
        seedBook({
          uri: 'at://did:plc:a/community.lexicon.book.book/ed2',
          isbn: '9780000000002',
          title: 'Dune (2)',
          identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
        });

        const c = mockContext({ queries: { uris: ['OL50W'] } });
        const res = await getBooks(c);
        expect(res.status).toBe(200);
        const body = await readJson(res);
        expect(body.books).toHaveLength(1);
        expect(body.multiMatch).toEqual([{ input: 'OL50W', count: 2 }]);
      });

      it('rejects unparseable inputs as invalid request', async () => {
        const c = mockContext({
          queries: { uris: ['not-a-real-identifier'] },
        });
        const res = await getBooks(c);
        expect(res.status).toBe(400);
      });
    });
  });

  describe('getReviews', () => {
    it('returns 400 when bookUri is missing', async () => {
      const c = mockContext();
      const res = await getReviews(c);
      expect(res.status).toBe(400);
    });

    it('returns reviews for a book', async () => {
      seedBook();
      db.insert(_s.reviews).values({
        uri: 'at://did:plc:r/review/1',
        did: 'did:plc:r',
        bookUri: 'at://did:plc:author/book/test001',
        text: 'Great book!',
        rating: 5,
        bookTitle: 'Test Book',
        bookAuthor: 'Test Author',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ query: { bookUri: 'at://did:plc:author/book/test001' } });
      const res = await getReviews(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.reviews).toHaveLength(1);
      expect(body.reviews[0].record.text).toBe('Great book!');
    });
  });

  describe('getReview', () => {
    function seedReview(overrides: Partial<typeof _s.reviews.$inferInsert> = {}) {
      db.insert(_s.reviews).values({
        uri: 'at://did:plc:r/review/1',
        did: 'did:plc:r',
        bookUri: 'at://did:plc:author/book/test001',
        text: 'Great book!',
        rating: 5,
        cid: 'bafyreicid111',
        bookTitle: 'Test Book',
        bookAuthor: 'Test Author',
        createdAt: new Date().toISOString(),
        ...overrides,
      }).run();
    }

    it('returns 400 when neither uri nor did+bookUri is provided', async () => {
      const c = mockContext();
      const res = await getReview(c);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe('InvalidRequest');
    });

    it('returns 400 when only did is provided', async () => {
      const c = mockContext({ query: { did: 'did:plc:r' } });
      const res = await getReview(c);
      expect(res.status).toBe(400);
    });

    it('returns 400 when only bookUri is provided', async () => {
      const c = mockContext({ query: { bookUri: 'at://did:plc:author/book/test001' } });
      const res = await getReview(c);
      expect(res.status).toBe(400);
    });

    it('returns 404 when review is not found', async () => {
      seedBook();
      const c = mockContext({ query: { uri: 'at://did:plc:r/review/nope' } });
      const res = await getReview(c);
      expect(res.status).toBe(404);
    });

    it('returns a review by uri', async () => {
      seedBook();
      seedReview();
      const c = mockContext({ query: { uri: 'at://did:plc:r/review/1' } });
      const res = await getReview(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.uri).toBe('at://did:plc:r/review/1');
      expect(body.did).toBe('did:plc:r');
      expect(body.cid).toBe('bafyreicid111');
      expect(body.record.text).toBe('Great book!');
      expect(body.record.bookRef).toEqual({
        uri: 'at://did:plc:author/book/test001',
        title: 'Test Book',
        author: 'Test Author',
      });
    });

    it('returns a review by did+bookUri', async () => {
      seedBook();
      seedReview();
      const c = mockContext({
        query: {
          did: 'did:plc:r',
          bookUri: 'at://did:plc:author/book/test001',
        },
      });
      const res = await getReview(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.uri).toBe('at://did:plc:r/review/1');
      expect(body.record.text).toBe('Great book!');
    });

    it('gives uri precedence when both uri and did+bookUri are provided', async () => {
      seedBook();
      seedReview();
      seedReview({ uri: 'at://did:plc:r/review/2', did: 'did:plc:r', cid: 'bafyreicid222' });
      const c = mockContext({
        query: {
          uri: 'at://did:plc:r/review/2',
          did: 'did:plc:r',
          bookUri: 'at://did:plc:author/book/test001',
        },
      });
      const res = await getReview(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.uri).toBe('at://did:plc:r/review/2');
      expect(body.cid).toBe('bafyreicid222');
    });
  });

  describe('getUserStatus', () => {
    it('returns 400 when did is missing', async () => {
      const c = mockContext();
      const res = await getUserStatus(c);
      expect(res.status).toBe(400);
    });

    it('returns statuses for a user', async () => {
      seedBook();
      db.insert(_s.readingStatuses).values({
        uri: 'at://did:plc:reader/status/1',
        did: 'did:plc:reader',
        bookUri: 'at://did:plc:author/book/test001',
        status: 'reading',
        progress: 42,
        bookTitle: 'Test Book',
        bookAuthor: 'Test Author',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ query: { did: 'did:plc:reader' } });
      const res = await getUserStatus(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.statuses).toHaveLength(1);
      expect(body.statuses[0].record.status).toBe('reading');
    });

    it('filters by status', async () => {
      seedBook();
      db.insert(_s.readingStatuses).values({
        uri: 'at://did:plc:reader/status/1',
        did: 'did:plc:reader',
        bookUri: 'at://did:plc:author/book/test001',
        status: 'reading',
        bookTitle: 'Test Book',
        bookAuthor: 'Test Author',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ query: { did: 'did:plc:reader', status: 'read' } });
      const res = await getUserStatus(c);
      const body = await readJson(res);
      expect(body.statuses).toEqual([]);
    });
  });

  describe('searchBooksHandler', () => {
    it('returns 400 when neither q nor identifier is provided', async () => {
      const c = mockContext();
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(400);
    });

    it('returns matching books', async () => {
      seedBook({ uri: 'at://did:plc:a/book/dune', title: 'Dune', author: 'Frank Herbert' });

      const c = mockContext({ query: { q: 'Dune' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toHaveLength(1);
    });

    it('strips quotes from query', async () => {
      seedBook({ uri: 'at://did:plc:a/book/dune', title: 'Dune' });

      const c = mockContext({ query: { q: '"Dune"' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toHaveLength(1);
    });

    it('matches by ISBN for numeric queries', async () => {
      seedBook({ uri: 'at://did:plc:a/book/1', title: 'Numeric', isbn: '978-0-12-345678-9' });

      const c = mockContext({ query: { q: '978-0-12' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toHaveLength(1);
    });

    it('searches by identifier type and value', async () => {
      const bookUri = 'at://did:plc:a/book/with-identifiers';
      getSqlite().prepare(
        `INSERT INTO books (uri, did, title, author, identifiers, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        bookUri,
        'did:plc:a',
        'Identifier Book',
        'Author X',
        JSON.stringify([{ type: 'oclc', value: '12345678' }, { type: 'asin', value: 'B00EXAMPLE' }]),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      const c = mockContext({ query: { q: '12345678', identifier: 'oclc' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toHaveLength(1);
      expect(body.books[0].uri).toBe(bookUri);
      expect(body.books[0].matchedIdentifier.type).toBe('oclc');
      expect(body.books[0].matchedIdentifier.value).toBe('12345678');
      expect(body.books[0].matchedIdentifier.status).toBe('json');
    });

    it('searches across all identifier types when no filter specified', async () => {
      const bookUri = 'at://did:plc:a/book/multi-id';
      getSqlite().prepare(
        `INSERT INTO books (uri, did, title, author, identifiers, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        bookUri,
        'did:plc:a',
        'Multi ID Book',
        'Author Z',
        JSON.stringify([{ type: 'asin', value: 'B00XYZ123' }]),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      const c = mockContext({ query: { q: 'B00XYZ', identifier: 'asin' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toHaveLength(1);
    });

    it('searches by verified claim identifiers', async () => {
      seedBook({ uri: 'at://did:plc:a/book/claimed', title: 'Claimed Book', author: 'Author C' });

      getSqlite().prepare(
        `INSERT INTO claims (uri, did, bookUri, identifier, identifierType, claimedBy, status, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'at://did:plc:a/claim/1',
        'did:plc:a',
        'at://did:plc:a/book/claimed',
        '9789876543210',
        'isbn',
        'did:plc:a',
        'verified',
        new Date().toISOString(),
      );

      const c = mockContext({ query: { q: '978987', identifier: 'isbn' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toHaveLength(1);
      expect(body.books[0].uri).toBe('at://did:plc:a/book/claimed');
      expect(body.books[0].matchedIdentifier.status).toBe('verified');
    });

    it('excludes unverified claims by default', async () => {
      seedBook({ uri: 'at://did:plc:a/book/pending', title: 'Pending Book', author: 'Author P' });

      getSqlite().prepare(
        `INSERT INTO claims (uri, did, bookUri, identifier, identifierType, claimedBy, status, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'at://did:plc:a/claim/2',
        'did:plc:a',
        'at://did:plc:a/book/pending',
        '9781111111110',
        'isbn',
        'did:plc:a',
        'pending',
        new Date().toISOString(),
      );

      const c = mockContext({ query: { q: '978111', identifier: 'isbn' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toEqual([]);
    });

    it('includes unverified claims when includeUnverified is true', async () => {
      seedBook({ uri: 'at://did:plc:a/book/pending2', title: 'Pending Book 2', author: 'Author P2' });

      getSqlite().prepare(
        `INSERT INTO claims (uri, did, bookUri, identifier, identifierType, claimedBy, status, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'at://did:plc:a/claim/3',
        'did:plc:a',
        'at://did:plc:a/book/pending2',
        '9782222222220',
        'isbn',
        'did:plc:a',
        'pending',
        new Date().toISOString(),
      );

      const c = mockContext({ query: { q: '978222', identifier: 'isbn', includeUnverified: 'true' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toHaveLength(1);
      expect(body.books[0].matchedIdentifier.status).toBe('pending');
    });

    it('searches identifiers without q value', async () => {
      const bookUri = 'at://did:plc:a/book/no-q';
      getSqlite().prepare(
        `INSERT INTO books (uri, did, title, author, identifiers, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        bookUri,
        'did:plc:a',
        'No Q Book',
        'Author NQ',
        JSON.stringify([{ type: 'ean', value: '5901234123457' }]),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      const c = mockContext({ query: { identifier: 'ean' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toHaveLength(1);
      expect(body.books[0].matchedIdentifier.type).toBe('ean');
    });

    it('blocks SQL injection via identifier type (comment payload)', async () => {
      const bookUri = 'at://did:plc:a/book/inject-type';
      getSqlite().prepare(
        `INSERT INTO books (uri, did, title, author, identifiers, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        bookUri,
        'did:plc:a',
        'Injection Book',
        'Author I',
        JSON.stringify([{ type: 'isbn', value: '9781234567890' }]),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      const c = mockContext({ query: { identifier: "isbn') OR 1=1 --" } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toEqual([]);
    });

    it('does not return all books for a SQL injection payload in q', async () => {
      const bookUri = 'at://did:plc:a/book/inject-q';
      getSqlite().prepare(
        `INSERT INTO books (uri, did, title, author, identifiers, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        bookUri,
        'did:plc:a',
        'Injection Q Book',
        'Author IQ',
        JSON.stringify([{ type: 'isbn', value: '9781111111111' }]),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      const c = mockContext({ query: { q: "' OR '1'='1", identifier: 'isbn' } });
      const res = await searchBooksHandler(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.books).toEqual([]);
    });

    describe('with provider fallback', () => {
      beforeEach(() => {
        vi.mocked(searchFallback).mockReset();
      });

      it('does not call fallback when local search has results', async () => {
        seedBook({ uri: 'at://did:plc:a/book/dune', title: 'Dune', author: 'Frank Herbert' });

        const c = mockContext({ query: { q: 'Dune' } });
        await searchBooksHandler(c);

        expect(searchFallback).not.toHaveBeenCalled();
      });

      it('calls fallback when local has no results and merges provider books into response', async () => {
        vi.mocked(searchFallback).mockResolvedValue({
          source: 'googleBooks',
          books: [
            {
              title: 'Dune',
              author: 'Frank Herbert',
              isbn13: '9780441172719',
              identifiers: { googleBooks: 'gb1' },
              sourceProvider: 'googleBooks',
            },
          ],
        });

        db.insert(_s.books).values({
          uri: 'at://did:web:localhost/community.lexicon.book.book/newrkey',
          did: 'did:web:localhost',
          title: 'Unrelated Seed',
          author: 'Other Author',
          isbn: '9780441172719',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).run();

        const c = mockContext({ query: { q: 'Dune' } });
        const res = await searchBooksHandler(c);
        const body = await readJson(res);

        expect(res.status).toBe(200);
        expect(searchFallback).toHaveBeenCalledTimes(1);
        expect(body.books).toHaveLength(1);
        expect(body.books[0].uri).toBe('at://did:web:localhost/community.lexicon.book.book/newrkey');
        expect(body.books[0].source).toBe('googleBooks');
        expect(body.books[0].record.title).toBe('Dune');
      });

      it('returns empty books when both local and fallback return nothing', async () => {
        vi.mocked(searchFallback).mockResolvedValue({ source: 'googleBooks', books: [] });

        const c = mockContext({ query: { q: 'Nothing' } });
        const res = await searchBooksHandler(c);
        const body = await readJson(res);

        expect(res.status).toBe(200);
        expect(searchFallback).toHaveBeenCalledTimes(1);
        expect(body.books).toEqual([]);
      });

      it('calls fallback on ISBN identifier branch when local has no matches', async () => {
        vi.mocked(searchFallback).mockResolvedValue({
          source: 'googleBooks',
          books: [
            {
              title: 'Dune',
              author: 'Frank Herbert',
              isbn13: '9780441172719',
              identifiers: { googleBooks: 'gb1' },
              sourceProvider: 'googleBooks',
            },
          ],
        });

        db.insert(_s.books).values({
          uri: 'at://did:web:localhost/community.lexicon.book.book/isbnrkey',
          did: 'did:web:localhost',
          title: 'Unrelated Seed',
          author: 'Other Author',
          isbn: '9780441172719',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).run();

        const c = mockContext({ query: { q: '9780441172719', identifier: 'isbn' } });
        const res = await searchBooksHandler(c);
        const body = await readJson(res);

        expect(res.status).toBe(200);
        expect(searchFallback).toHaveBeenCalledTimes(1);
        expect(body.books).toHaveLength(1);
        expect(body.books[0].source).toBe('googleBooks');
      });

      it('does not call fallback on non-ISBN identifier branch even when local is empty', async () => {
        const c = mockContext({ query: { q: '9780441172719', identifier: 'oclc' } });
        const res = await searchBooksHandler(c);
        const body = await readJson(res);

        expect(res.status).toBe(200);
        expect(searchFallback).not.toHaveBeenCalled();
        expect(body.books).toEqual([]);
      });

      it('does not call fallback on ISBN identifier branch when q is missing', async () => {
        const c = mockContext({ query: { identifier: 'isbn' } });
        const res = await searchBooksHandler(c);
        const body = await readJson(res);

        expect(res.status).toBe(200);
        expect(searchFallback).not.toHaveBeenCalled();
        expect(body.books).toEqual([]);
      });
    });
  });

  describe('listBooksHandler', () => {
    function seedListBook(uri: string, opts: {
      title?: string;
      status?: 'pending' | 'active' | 'rejected';
      createdAt?: string;
      isbn?: string | null;
    } = {}) {
      const now = new Date().toISOString();
      db.insert(_s.books).values({
        uri,
        did: 'did:plc:author',
        title: opts.title ?? `Book ${uri}`,
        author: 'Author',
        isbn: opts.isbn ?? null,
        status: opts.status ?? 'active',
        createdAt: opts.createdAt ?? now,
        updatedAt: opts.createdAt ?? now,
      }).run();
    }

    it('returns the first page ordered by createdAt ASC, uri ASC with default limit 50', async () => {
      seedListBook('at://did:plc:a/book/c', { title: 'C', createdAt: '2024-03-03T00:00:00.000Z' });
      seedListBook('at://did:plc:a/book/a', { title: 'A', createdAt: '2024-03-01T00:00:00.000Z' });
      seedListBook('at://did:plc:a/book/b', { title: 'B', createdAt: '2024-03-02T00:00:00.000Z' });

      const c = mockContext();
      const res = await listBooksHandler(c);
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.books.map((b: { uri: string }) => b.uri)).toEqual([
        'at://did:plc:a/book/a',
        'at://did:plc:a/book/b',
        'at://did:plc:a/book/c',
      ]);
      expect(body.cursor).toBeUndefined();
    });

    it('advances to the next page when cursor is provided', async () => {
      for (let i = 0; i < 5; i++) {
        seedListBook(`at://did:plc:a/book/p${i}`, { createdAt: `2024-01-0${i + 1}T00:00:00.000Z` });
      }

      const page1 = await readJson(await listBooksHandler(mockContext({ query: { limit: '2' } })));
      expect(page1.books.map((b: { uri: string }) => b.uri)).toEqual([
        'at://did:plc:a/book/p0',
        'at://did:plc:a/book/p1',
      ]);
      expect(page1.cursor).toBe('2');

      const page2 = await readJson(await listBooksHandler(mockContext({ query: { limit: '2', cursor: '2' } })));
      expect(page2.books.map((b: { uri: string }) => b.uri)).toEqual([
        'at://did:plc:a/book/p2',
        'at://did:plc:a/book/p3',
      ]);
      expect(page2.cursor).toBe('4');

      const page3 = await readJson(await listBooksHandler(mockContext({ query: { limit: '2', cursor: '4' } })));
      expect(page3.books.map((b: { uri: string }) => b.uri)).toEqual([
        'at://did:plc:a/book/p4',
      ]);
      expect(page3.cursor).toBeUndefined();
    });

    it('excludes rejected records and includes pending only when includeUnverified=true', async () => {
      seedListBook('at://did:plc:a/book/active', { status: 'active' });
      seedListBook('at://did:plc:a/book/pending', { status: 'pending' });
      seedListBook('at://did:plc:a/book/rejected', { status: 'rejected' });

      const defaultBody = await readJson(await listBooksHandler(mockContext()));
      expect(defaultBody.books.map((b: { uri: string }) => b.uri).sort()).toEqual([
        'at://did:plc:a/book/active',
      ]);

      const withUnverified = await readJson(await listBooksHandler(mockContext({ query: { includeUnverified: 'true' } })));
      expect(withUnverified.books.map((b: { uri: string }) => b.uri).sort()).toEqual([
        'at://did:plc:a/book/active',
        'at://did:plc:a/book/pending',
      ]);
    });

    it('returns an empty page with no cursor when there are no more rows', async () => {
      seedListBook('at://did:plc:a/book/single', { createdAt: '2024-01-01T00:00:00.000Z' });

      const res = await listBooksHandler(mockContext({ query: { cursor: '50' } }));
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.books).toEqual([]);
      expect(body.cursor).toBeUndefined();
    });

    it('clamps limit to the documented bounds via parsePagination', async () => {
      for (let i = 0; i < 3; i++) {
        seedListBook(`at://did:plc:a/book/c${i}`, { createdAt: `2024-02-0${i + 1}T00:00:00.000Z` });
      }

      const zeroBody = await readJson(await listBooksHandler(mockContext({ query: { limit: '0' } })));
      expect(zeroBody.books).toHaveLength(1);

      const hugeBody = await readJson(await listBooksHandler(mockContext({ query: { limit: '99999' } })));
      expect(hugeBody.books).toHaveLength(3);
    });
  });

  describe('getClaims', () => {
    it('returns 400 when bookUri is missing', async () => {
      const c = mockContext();
      const res = await getClaims(c);
      expect(res.status).toBe(400);
    });

    it('returns claims for a book', async () => {
      seedBook();
      db.insert(_s.claims).values({
        uri: 'at://did:plc:author/claim/1',
        did: 'did:plc:author',
        bookUri: 'at://did:plc:author/book/test001',
        identifier: '9781234567890',
        identifierType: 'isbn',
        claimedBy: 'did:plc:author',
        status: 'verified',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ query: { bookUri: 'at://did:plc:author/book/test001' } });
      const res = await getClaims(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.claims).toHaveLength(1);
    });
  });

  describe('getLabelerLabels', () => {
    it('returns 400 when uri is missing', async () => {
      const c = mockContext();
      const res = await getLabelerLabels(c);
      expect(res.status).toBe(400);
    });

    it('returns labels for a URI', async () => {
      seedBook();
      seedLabel('did:web:localhost', 'at://did:plc:author/book/test001', 'book:author');

      const c = mockContext({ query: { uri: 'at://did:plc:author/book/test001' } });
      const res = await getLabelerLabels(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.labels).toHaveLength(1);
    });

    it('filters by value', async () => {
      seedBook();
      seedLabel('did:web:localhost', 'at://did:plc:author/book/test001', 'book:author');
      seedLabel('did:web:localhost', 'at://did:plc:author/book/test001', 'book:librarian');

      const c = mockContext({
        query: { uri: 'at://did:plc:author/book/test001', val: 'book:author' },
      });
      const res = await getLabelerLabels(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.labels).toHaveLength(1);
    });
  });

  describe('getShelves', () => {
    it('returns 400 when did is missing', async () => {
      const c = mockContext();
      const res = await getShelves(c);
      expect(res.status).toBe(400);
    });

    it('returns shelves for a user', async () => {
      db.insert(_s.shelves).values({
        uri: 'at://did:plc:user/community.lexicon.book.shelf/shf001',
        did: 'did:plc:user',
        name: 'Sci-Fi Favorites',
        description: 'Top picks',
        metadata: { theme: 'scifi' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ query: { did: 'did:plc:user' } });
      const res = await getShelves(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.shelves).toHaveLength(1);
      expect(body.shelves[0].record.name).toBe('Sci-Fi Favorites');
      expect(body.shelves[0].record.metadata).toEqual({ theme: 'scifi' });
    });

    it('does not return shelves for other users', async () => {
      db.insert(_s.shelves).values({
        uri: 'at://did:plc:other/community.lexicon.book.shelf/shf001',
        did: 'did:plc:other',
        name: 'Other Shelf',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ query: { did: 'did:plc:user' } });
      const res = await getShelves(c);
      const body = await readJson(res);
      expect(body.shelves).toEqual([]);
    });
  });

  describe('getShelf', () => {
    it('returns 400 when uri is missing', async () => {
      const c = mockContext();
      const res = await getShelf(c);
      expect(res.status).toBe(400);
    });

    it('returns 404 when shelf not found', async () => {
      const c = mockContext({ query: { uri: 'at://did:plc:unknown/shelf/missing' } });
      const res = await getShelf(c);
      expect(res.status).toBe(404);
    });

    it('returns shelf when found', async () => {
      db.insert(_s.shelves).values({
        uri: 'at://did:plc:user/community.lexicon.book.shelf/shf001',
        did: 'did:plc:user',
        name: 'Reading List',
        coverUrl: 'https://example.com/cover.jpg',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ query: { uri: 'at://did:plc:user/community.lexicon.book.shelf/shf001' } });
      const res = await getShelf(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.record.name).toBe('Reading List');
      expect(body.record.coverUrl).toBe('https://example.com/cover.jpg');
    });
  });

  describe('getShelfItems', () => {
    it('returns 400 when shelfUri is missing', async () => {
      const c = mockContext();
      const res = await getShelfItems(c);
      expect(res.status).toBe(400);
    });

    it('returns items for a shelf', async () => {
      seedBook();
      db.insert(_s.shelves).values({
        uri: 'at://did:plc:user/community.lexicon.book.shelf/shf001',
        did: 'did:plc:user',
        name: 'Shelf',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
      db.insert(_s.shelfItems).values({
        uri: 'at://did:plc:user/community.lexicon.book.shelfItem/sii001',
        did: 'did:plc:user',
        shelfUri: 'at://did:plc:user/community.lexicon.book.shelf/shf001',
        bookUri: 'at://did:plc:author/book/test001',
        bookTitle: 'Test Book',
        bookAuthor: 'Test Author',
        note: 'favorite',
        createdAt: new Date().toISOString(),
      }).run();

      const c = mockContext({ query: { shelfUri: 'at://did:plc:user/community.lexicon.book.shelf/shf001' } });
      const res = await getShelfItems(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].record.bookRef.title).toBe('Test Book');
      expect(body.items[0].record.note).toBe('favorite');
    });
  });
});
