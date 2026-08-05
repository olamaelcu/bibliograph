import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb, clearAllTables, type TestDb } from '../test-utils/db.js';
import type { BookData } from '../providers/interface.js';

const searchFallback = async (...args: Parameters<typeof import('./search-fallback.js').searchFallback>) =>
  (await import('./search-fallback.js')).searchFallback(...args);

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function gbResponse(items: unknown[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ items }),
  };
}

function gbEmptyResponse() {
  return gbResponse([]);
}

function olResponse(docs: unknown[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ docs }),
  };
}

function olEmptyResponse() {
  return olResponse([]);
}

function gbVolume(vi: Record<string, unknown>, id = 'gb1') {
  return { id, volumeInfo: vi };
}

function olDoc(doc: Record<string, unknown>) {
  return doc;
}

describe('api/search-fallback', () => {
  let testDb: TestDb;
  let fetchMock: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof makeLog>;

  beforeEach(() => {
    testDb = createTestDb();
    clearAllTables(testDb.db);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    log = makeLog();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.GOOGLE_BOOKS_API_KEY;
  });

  describe('title search', () => {
    it('queries Google Books first and Open Library second', async () => {
      fetchMock.mockResolvedValueOnce(gbEmptyResponse()).mockResolvedValueOnce(olEmptyResponse());

      await searchFallback(testDb.db, 'Dune', log);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const urls = fetchMock.mock.calls.map(c => c[0] as string);
      expect(urls[0]).toContain('googleapis.com/books');
      expect(urls[1]).toContain('openlibrary.org');
    });

    it('returns GB results when GB has results, with OL items deduped', async () => {
      fetchMock
        .mockResolvedValueOnce(gbResponse([
          gbVolume(
            {
              title: 'Dune',
              authors: ['Frank Herbert'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441172719' }],
              publishedDate: '1965',
            },
            'gb-dune',
          ),
        ]))
        .mockResolvedValueOnce(olResponse([
          olDoc({
            title: 'Dune',
            author_name: ['Frank Herbert'],
            key: '/works/OL1W',
            isbn: ['9780441172719'],
          }),
          olDoc({
            title: 'Dune Messiah',
            author_name: ['Frank Herbert'],
            key: '/works/OL2W',
          }),
        ]));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.source).toBe('googleBooks');
      expect(result.books).toHaveLength(2);
      const titles = result.books.map(b => b.title);
      expect(titles).toContain('Dune');
      expect(titles).toContain('Dune Messiah');
      expect(result.books[0].sourceProvider).toBe('googleBooks');
    });

    it('returns source=googleBooks even when GB returns empty and OL returns results', async () => {
      fetchMock
        .mockResolvedValueOnce(gbEmptyResponse())
        .mockResolvedValueOnce(olResponse([
          olDoc({
            title: 'Dune',
            author_name: ['Frank Herbert'],
            key: '/works/OL1W',
            first_publish_year: 1965,
          }),
        ]));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.source).toBe('googleBooks');
      expect(result.books).toHaveLength(1);
      expect(result.books[0].sourceProvider).toBe('openLibrary');
    });

    it('returns empty books when both providers return empty', async () => {
      fetchMock.mockResolvedValueOnce(gbEmptyResponse()).mockResolvedValueOnce(olEmptyResponse());

      const result = await searchFallback(testDb.db, 'Nothing', log);

      expect(result.source).toBe('googleBooks');
      expect(result.books).toEqual([]);
    });
  });

  describe('isbn search', () => {
    it('detects numeric q and queries GB by ISBN', async () => {
      fetchMock
        .mockResolvedValueOnce(gbResponse([
          gbVolume(
            {
              title: 'Dune',
              authors: ['Frank Herbert'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441172719' }],
            },
            'gb-dune',
          ),
        ]))
        .mockResolvedValueOnce(olEmptyResponse());

      const result = await searchFallback(testDb.db, '9780441172719', log);

      expect(result.source).toBe('googleBooks');
      const gbUrl = fetchMock.mock.calls[0][0] as string;
      expect(gbUrl).toContain('isbn:9780441172719');
    });

    it('treats q with dashes as ISBN', async () => {
      fetchMock.mockResolvedValueOnce(gbEmptyResponse()).mockResolvedValueOnce(olEmptyResponse());

      await searchFallback(testDb.db, '978-0-441-17271-9', log);

      const gbUrl = fetchMock.mock.calls[0][0] as string;
      expect(gbUrl).toContain('isbn:978-0-441-17271-9');
      const olUrl = fetchMock.mock.calls[1][0] as string;
      expect(olUrl).toContain('isbn:978-0-441-17271-9');
    });
  });

  describe('no API key', () => {
    it('skips Google Books and queries only Open Library when GOOGLE_BOOKS_API_KEY is missing', async () => {
      delete process.env.GOOGLE_BOOKS_API_KEY;
      fetchMock.mockResolvedValueOnce(olResponse([
        olDoc({
          title: 'Dune',
          author_name: ['Frank Herbert'],
          key: '/works/OL1W',
        }),
      ]));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.source).toBe('openlibrary');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('openlibrary.org');
    });

    it('returns source=openlibrary with empty books when no API key and OL is empty', async () => {
      delete process.env.GOOGLE_BOOKS_API_KEY;
      fetchMock.mockResolvedValueOnce(olEmptyResponse());

      const result = await searchFallback(testDb.db, 'Nothing', log);

      expect(result.source).toBe('openlibrary');
      expect(result.books).toEqual([]);
    });
  });

  describe('network failures', () => {
    it('falls back to OL when GB fetch fails (provider swallows, returns empty)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('GB down')).mockResolvedValueOnce(olResponse([
        olDoc({
          title: 'Dune',
          author_name: ['Frank Herbert'],
          key: '/works/OL1W',
        }),
      ]));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.source).toBe('googleBooks');
      expect(result.books).toHaveLength(1);
      expect(result.books[0].sourceProvider).toBe('openLibrary');
    });

    it('returns GB results even when OL fetch fails (provider swallows)', async () => {
      fetchMock
        .mockResolvedValueOnce(gbResponse([
          gbVolume(
            {
              title: 'Dune',
              authors: ['Frank Herbert'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441172719' }],
            },
            'gb-dune',
          ),
        ]))
        .mockRejectedValueOnce(new Error('OL down'));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.source).toBe('googleBooks');
      expect(result.books).toHaveLength(1);
      expect(result.books[0].sourceProvider).toBe('googleBooks');
    });

    it('returns source=googleBooks with empty books when both fetches fail', async () => {
      fetchMock.mockRejectedValueOnce(new Error('GB down')).mockRejectedValueOnce(new Error('OL down'));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.source).toBe('googleBooks');
      expect(result.books).toEqual([]);
    });
  });

  describe('provider throws', () => {
    it('falls back to OL when GB throws and OL fetch also fails (returns empty)', async () => {
      const { GoogleBooksProvider } = await import('../providers/googlebooks.js');
      vi.spyOn(GoogleBooksProvider.prototype, 'searchByTitle').mockRejectedValueOnce(
        new Error('GB method exploded'),
      );
      fetchMock.mockRejectedValueOnce(new Error('OL down'));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.source).toBe('openlibrary');
      expect(result.books).toEqual([]);
      expect(log.error).toHaveBeenCalled();
    });

    it('returns source=openlibrary when GB throws and OL succeeds', async () => {
      const { GoogleBooksProvider } = await import('../providers/googlebooks.js');
      vi.spyOn(GoogleBooksProvider.prototype, 'searchByTitle').mockRejectedValueOnce(
        new Error('GB method exploded'),
      );
      fetchMock.mockResolvedValueOnce(olResponse([
        olDoc({
          title: 'Dune',
          author_name: ['Frank Herbert'],
          key: '/works/OL1W',
        }),
      ]));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.source).toBe('openlibrary');
      expect(result.books).toHaveLength(1);
      expect(result.books[0].sourceProvider).toBe('openLibrary');
    });
  });

  describe('cross-provider dedup', () => {
    it('matches ISBN-13 ignoring dashes and whitespace', async () => {
      fetchMock
        .mockResolvedValueOnce(gbResponse([
          gbVolume(
            {
              title: 'Dune',
              authors: ['Frank Herbert'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '978-0-441-17271-9' }],
            },
            'gb-dune',
          ),
        ]))
        .mockResolvedValueOnce(olResponse([
          olDoc({
            title: 'Dune',
            author_name: ['Frank Herbert'],
            key: '/works/OL1W',
            isbn: ['9780441172719'],
          }),
        ]));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.books).toHaveLength(1);
      expect(result.books[0].sourceProvider).toBe('googleBooks');
    });

    it('drops an OL result that matches a GB result by dedup hash when neither has an ISBN', async () => {
      fetchMock
        .mockResolvedValueOnce(gbResponse([
          gbVolume(
            {
              title: 'Dune',
              authors: ['Frank Herbert'],
              publishedDate: '1965',
            },
            'gb-dune',
          ),
        ]))
        .mockResolvedValueOnce(olResponse([
          olDoc({
            title: 'Dune!',
            author_name: ['frank herbert'],
            key: '/works/OL1W',
            first_publish_year: 1965,
          }),
        ]));

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.books).toHaveLength(1);
      expect(result.books[0].sourceProvider).toBe('googleBooks');
    });
  });

  describe('import behavior', () => {
    it('inserts returned books into the database', async () => {
      fetchMock.mockResolvedValueOnce(gbResponse([
        gbVolume(
          {
            title: 'Dune',
            authors: ['Frank Herbert'],
            industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441172719' }],
            publishedDate: '1965',
          },
          'gb-dune',
        ),
      ])).mockResolvedValueOnce(olEmptyResponse());

      const result = await searchFallback(testDb.db, 'Dune', log);

      expect(result.books).toHaveLength(1);
      const rows = testDb.db.select().from(testDb.schema.books).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Dune');
      expect(rows[0].isbn).toBe('9780441172719');
    });

    it('does not insert a deduped OL result', async () => {
      fetchMock
        .mockResolvedValueOnce(gbResponse([
          gbVolume(
            {
              title: 'Dune',
              authors: ['Frank Herbert'],
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441172719' }],
            },
            'gb-dune',
          ),
        ]))
        .mockResolvedValueOnce(olResponse([
          olDoc({
            title: 'Dune',
            author_name: ['Frank Herbert'],
            key: '/works/OL1W',
            isbn: ['9780441172719'],
          }),
        ]));

      await searchFallback(testDb.db, 'Dune', log);

      const rows = testDb.db.select().from(testDb.schema.books).all();
      expect(rows).toHaveLength(1);
    });

    it('caps imports at 10 even if GB returns more', async () => {
      const items = Array.from({ length: 12 }, (_, i) =>
        gbVolume(
          {
            title: `Book ${i}`,
            authors: [`Author ${i}`],
            industryIdentifiers: [{ type: 'ISBN_13', identifier: `9780000000${String(i).padStart(3, '0')}` }],
          },
          `gb-${i}`,
        ),
      );
      fetchMock.mockResolvedValueOnce(gbResponse(items)).mockResolvedValueOnce(olEmptyResponse());

      await searchFallback(testDb.db, 'Anything', log);

      const rows = testDb.db.select().from(testDb.schema.books).all();
      expect(rows).toHaveLength(10);
    });

    it('continues importing OL items when GB items are all skipped (already in DB)', async () => {
      testDb.db.insert(testDb.schema.books).values({
        uri: 'at://did:web:localhost/community.lexicon.book.book/existing',
        did: 'did:web:localhost',
        title: 'Existing',
        author: 'Existing Author',
        isbn: '9780000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const gbItems = Array.from({ length: 8 }, (_, i) =>
        gbVolume(
          {
            title: 'Existing',
            authors: ['Existing Author'],
            industryIdentifiers: [{ type: 'ISBN_13', identifier: `9780000000${String(i + 1).padStart(3, '0')}` }],
          },
          `gb-existing-${i}`,
        ),
      );
      const olItems = Array.from({ length: 5 }, (_, i) =>
        olDoc({
          title: `OL Book ${i}`,
          author_name: [`OL Author ${i}`],
          key: `/works/OL${i}W`,
        }),
      );

      fetchMock.mockResolvedValueOnce(gbResponse(gbItems)).mockResolvedValueOnce(olResponse(olItems));

      const result = await searchFallback(testDb.db, 'Anything', log);

      expect(result.books).toHaveLength(8 + 5);
      const rows = testDb.db.select().from(testDb.schema.books).all();
      const olRows = rows.filter(r => r.title.startsWith('OL Book'));
      expect(olRows).toHaveLength(5);
    });

    it('logs a warning when the import cap stops further imports', async () => {
      const items = Array.from({ length: 15 }, (_, i) =>
        gbVolume(
          {
            title: `Book ${i}`,
            authors: [`Author ${i}`],
            industryIdentifiers: [{ type: 'ISBN_13', identifier: `9781111111${String(i).padStart(3, '0')}` }],
          },
          `gb-${i}`,
        ),
      );
      fetchMock.mockResolvedValueOnce(gbResponse(items)).mockResolvedValueOnce(olEmptyResponse());

      await searchFallback(testDb.db, 'Anything', log);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ cap: 10 }),
        'searchFallback: import cap reached',
      );
    });
  });
});