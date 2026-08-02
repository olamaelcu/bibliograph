import { describe, it, expect, vi, afterEach } from 'vitest';
import { backfillOpenLibraryFromIsbns } from './openlibrary-backfill.js';
import { createTestDb } from './test-utils/db.js';
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
  for (const t of [_s.books, _s.claims, _s.reviews, _s.readingStatuses, _s.shelves, _s.shelfItems]) {
    db.delete(t).run();
  }
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
