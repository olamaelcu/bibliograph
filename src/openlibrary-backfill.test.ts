import { describe, it, expect, vi, afterEach } from 'vitest';
import { backfillOpenLibraryFromIsbns, backfillOpenLibraryAuthor } from './openlibrary-backfill.js';
import { createTestDb, clearAllTables } from './test-utils/db.js';
import * as _s from './db/schema.js';

const { db } = createTestDb();

function mockOpenLibrary(doc: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ docs: [doc] }),
  } as Response)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAllTables(db);
});

describe('backfillOpenLibraryFromIsbns', () => {
  it('imports a new book as active with a generated uri', async () => {
    mockOpenLibrary({
      title: 'Dune',
      author_name: ['Frank Herbert'],
      isbn_13: ['9780441172719'],
      first_publish_year: 1965,
    });

    const summary = await backfillOpenLibraryFromIsbns(db, ['9780441172719']);

    expect(summary.imported).toBe(1);
    const book = db.select().from(_s.books).all()[0];
    expect(book.title).toBe('Dune');
    expect(book.isbn).toBe('9780441172719');
    expect(book.status).toBe('active');
    expect(book.uri).toMatch(/^at:\/\/did:web:localhost\/community\.lexicon\.book\.book\/[a-z0-9]{13}$/);
  });

  it('skips an ISBN already present in the database', async () => {
    const now = new Date().toISOString();
    db.insert(_s.books).values({ uri: 'at://did:web:localhost/community.lexicon.book.book/existing', did: 'did:web:localhost', title: 'Old', author: 'A', isbn: '9780441172719', status: 'active', createdAt: now, updatedAt: now }).run();
    mockOpenLibrary({ title: 'Dune', author_name: ['Frank Herbert'], isbn_13: ['9780441172719'] });

    const summary = await backfillOpenLibraryFromIsbns(db, ['9780441172719']);

    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(db.select().from(_s.books).all()).toHaveLength(1);
  });

  it('reports not-found when OpenLibrary returns nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ docs: [] }) } as Response)));
    const summary = await backfillOpenLibraryFromIsbns(db, ['9780000000000']);
    expect(summary.notFound).toBe(1);
  });
});

describe('backfillOpenLibraryAuthor', () => {
  it('rejects an invalid author key', async () => {
    await expect(backfillOpenLibraryAuthor(db, 'not-a-key')).rejects.toThrow(/invalid OpenLibrary author key/);
  });

  it('reports notFound when the author has no books', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ numFound: 0, docs: [] }) } as Response)));
    const summary = await backfillOpenLibraryAuthor(db, 'OL23919A');
    expect(summary.notFound).toBe(1);
  });

  it('paginates through all of an author works', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ numFound: 2, docs: [{ title: 'Dune', author_name: ['Frank Herbert'], key: '/works/OL1W', isbn_13: ['9780441172719'] }] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ numFound: 2, docs: [{ title: 'Dune Messiah', author_name: ['Frank Herbert'], key: '/works/OL2W', isbn_13: ['9780441172726'] }] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const summary = await backfillOpenLibraryAuthor(db, 'OL23919A', { limit: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary.imported).toBe(2);
    const books = db.select().from(_s.books).all();
    expect(books).toHaveLength(2);
    expect(books.every(b => b.status === 'active')).toBe(true);
  });

  it('deduplicates the same work across pages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ numFound: 2, docs: [{ title: 'Dune', author_name: ['Frank Herbert'], key: '/works/OL1W', isbn_13: ['9780441172719'] }] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ numFound: 2, docs: [{ title: 'Dune', author_name: ['Frank Herbert'], key: '/works/OL1W', isbn_13: ['9780441172719'] }] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const summary = await backfillOpenLibraryAuthor(db, 'OL23919A', { limit: 1 });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(db.select().from(_s.books).all()).toHaveLength(1);
  });

  it('skips a work already in the database by ISBN', async () => {
    const now = new Date().toISOString();
    db.insert(_s.books).values({ uri: 'at://did:web:localhost/community.lexicon.book.book/existing', did: 'did:web:localhost', title: 'Old', author: 'A', isbn: '9780441172719', status: 'active', createdAt: now, updatedAt: now }).run();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ numFound: 1, docs: [{ title: 'Dune', author_name: ['Frank Herbert'], key: '/works/OL1W', isbn_13: ['9780441172719'] }] }) } as Response)));

    const summary = await backfillOpenLibraryAuthor(db, 'OL23919A');

    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(db.select().from(_s.books).all()).toHaveLength(1);
  });
});
