import { describe, it, expect, vi, afterEach } from 'vitest';
import { backfillGoogleBooksFromIsbns, backfillGoogleBooksAuthor } from './googlebooks-backfill.js';
import { createTestDb, clearAllTables } from './test-utils/db.js';
import * as _s from './db/schema.js';

const { db } = createTestDb();

function volume(id: string, title: string, isbn13?: string) {
  return {
    id,
    volumeInfo: {
      title,
      authors: ['Frank Herbert'],
      industryIdentifiers: isbn13 ? [{ type: 'ISBN_13', identifier: isbn13 }] : undefined,
    },
  };
}

function volumes(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => volume(`vid-${prefix}-${i}`, `Book ${prefix} ${i}`));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_BOOKS_API_KEY;
  clearAllTables(db);
});

describe('backfillGoogleBooksFromIsbns', () => {
  it('throws when GOOGLE_BOOKS_API_KEY is not set', async () => {
    await expect(backfillGoogleBooksFromIsbns(db, ['9780441172719'])).rejects.toThrow(/GOOGLE_BOOKS_API_KEY/);
  });

  it('imports a new book as active with a googleBooks identifier', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ totalItems: 1, items: [volume('v1', 'Dune', '9780441172719')] }),
    } as Response)));

    const summary = await backfillGoogleBooksFromIsbns(db, ['9780441172719']);

    expect(summary.imported).toBe(1);
    const book = db.select().from(_s.books).all()[0];
    expect(book.title).toBe('Dune');
    expect(book.isbn).toBe('9780441172719');
    expect(book.status).toBe('active');
    const idents = typeof book.identifiers === 'string' ? JSON.parse(book.identifiers) : book.identifiers;
    expect(idents).toContainEqual({ type: 'googleBooks', value: 'v1' });
  });

  it('skips an ISBN already present in the database', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    const now = new Date().toISOString();
    db.insert(_s.books).values({ uri: 'at://did:web:localhost/community.lexicon.book.book/existing', did: 'did:web:localhost', title: 'Old', author: 'A', isbn: '9780441172719', status: 'active', createdAt: now, updatedAt: now }).run();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ totalItems: 1, items: [volume('v1', 'Dune', '9780441172719')] }),
    } as Response)));

    const summary = await backfillGoogleBooksFromIsbns(db, ['9780441172719']);

    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(db.select().from(_s.books).all()).toHaveLength(1);
  });

  it('reports not-found when Google Books returns nothing', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ totalItems: 0 }) } as Response)));
    const summary = await backfillGoogleBooksFromIsbns(db, ['9780000000000']);
    expect(summary.notFound).toBe(1);
  });
});

describe('backfillGoogleBooksAuthor', () => {
  it('throws when GOOGLE_BOOKS_API_KEY is not set', async () => {
    await expect(backfillGoogleBooksAuthor(db, 'Frank Herbert')).rejects.toThrow(/GOOGLE_BOOKS_API_KEY/);
  });

  it('rejects an empty author name', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    await expect(backfillGoogleBooksAuthor(db, '')).rejects.toThrow(/author name/);
  });

  it('reports notFound when the author has no books', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ totalItems: 0 }) } as Response)));
    const summary = await backfillGoogleBooksAuthor(db, 'Nobody');
    expect(summary.notFound).toBe(1);
  });

  it('paginates through all of an author volumes', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 2, items: [volume('v1', 'Dune', '9780441172719')] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 2, items: [volume('v2', 'Dune Messiah', '9780441172726')] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 2, items: [] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const summary = await backfillGoogleBooksAuthor(db, 'Frank Herbert', { maxResults: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0] as string).toContain('startIndex=1');
    expect(fetchMock.mock.calls[2][0] as string).toContain('startIndex=2');
    expect(summary.imported).toBe(2);
    expect(db.select().from(_s.books).all()).toHaveLength(2);
  });

  it('pages through all results even when the API caps each page below maxResults', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 20, items: volumes(20, 'a') }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 20, items: volumes(20, 'b') }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 20, items: [] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const summary = await backfillGoogleBooksAuthor(db, 'Frank Herbert');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(summary.imported).toBe(40);
    expect(db.select().from(_s.books).all()).toHaveLength(40);
  });

  it('stops paging once a page returns fewer results than the page size', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 3, items: [volume('v1', 'Dune', '9780441172719'), volume('v2', 'Dune Messiah', '9780441172726')] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 3, items: [volume('v3', 'Children of Dune', '9780441104024')] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const summary = await backfillGoogleBooksAuthor(db, 'Frank Herbert', { maxResults: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary.imported).toBe(3);
  });

  it('stops paginating once the page cap is reached', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    const page = { ok: true, json: async () => ({ totalItems: 999, items: [volume('v1', 'Dune', '9780441172719')] }) } as Response;
    const fetchMock = vi.fn().mockResolvedValue(page);
    vi.stubGlobal('fetch', fetchMock);

    const summary = await backfillGoogleBooksAuthor(db, 'Frank Herbert', { maxResults: 1, maxPages: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(summary.imported).toBe(1);
  });

  it('deduplicates the same title across pages', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 2, items: [volume('v1', 'Dune', '9780441172719')] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totalItems: 2, items: [volume('v2', 'Dune', '9780441172726')] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const summary = await backfillGoogleBooksAuthor(db, 'Frank Herbert', { maxResults: 1 });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(db.select().from(_s.books).all()).toHaveLength(1);
  });
});
