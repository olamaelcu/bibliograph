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

import { db, schema } from '../db/connection.js';
const _s = schema;
const _d = db as any;

import { getBook, getBooks, getReviews, getUserStatus, searchBooksHandler, getClaims, getLabelerLabels } from './get-book.js';

function getSqlite() {
  return _d.$sqlite as import('better-sqlite3').default;
}

function clearTables() {
  const sqlite = getSqlite();
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .filter(t => !t.name.startsWith('sqlite_') && !t.name.startsWith('__drizzle'));
  for (const t of tables) {
    try { sqlite.prepare(`DELETE FROM "${t.name}"`).run(); } catch {}
  }
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
    it('returns 400 when q is missing', async () => {
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
});
