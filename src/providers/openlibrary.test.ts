import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenLibraryProvider } from './openlibrary.js';

describe('OpenLibraryProvider', () => {
  let provider: OpenLibraryProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new OpenLibraryProvider();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getName', () => {
    it('returns "Open Library"', () => {
      expect(provider.getName()).toBe('Open Library');
    });
  });

  describe('searchByIsbn', () => {
    it('returns null when no docs are found', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await provider.searchByIsbn('9781234567890');
      expect(result).toBeNull();
    });

    it('returns mapped BookData when a doc is found', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          docs: [{
            title: 'Dune',
            author_name: ['Frank Herbert'],
            isbn: ['9780441172719'],
            first_publish_year: 1965,
            number_of_pages: 412,
            subject: ['Science Fiction', 'Epic'],
            cover_i: 12345,
            key: '/works/OL893415W',
          }],
        }),
      });

      const result = await provider.searchByIsbn('9780441172719');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Dune');
      expect(result!.author).toBe('Frank Herbert');
      expect(result!.sourceProvider).toBe('openLibrary');
    });

    it('maps identifiers from the doc', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          docs: [{
            title: 'Test Book',
            author_name: ['Author'],
            key: '/works/OL123W',
            identifiers: { lccn: '2020123456' },
            first_publish_year: 2020,
          }],
        }),
      });

      const result = await provider.searchByIsbn('9780000000001');
      expect(result!.identifiers['openlibrary']).toBe('/works/OL123W');
      expect(result!.identifiers['lccn']).toBe('2020123456');
    });

    it('returns null on network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      const result = await provider.searchByIsbn('9780000000001');
      expect(result).toBeNull();
    });

    it('returns null when response is not ok', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await provider.searchByIsbn('9780000000001');
      expect(result).toBeNull();
    });
  });

  describe('searchByTitle', () => {
    it('returns results when found', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          docs: [
            {
              title: 'Dune',
              author_name: ['Frank Herbert'],
              first_publish_year: 1965,
              key: '/works/OL893415W',
            },
            {
              title: 'Dune Messiah',
              author_name: ['Frank Herbert'],
              first_publish_year: 1969,
              key: '/works/OL893416W',
            },
          ],
        }),
      });

      const results = await provider.searchByTitle('Dune');
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Dune');
    });

    it('includes author in search when provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ docs: [] }),
      });

      await provider.searchByTitle('Dune', 'Frank Herbert');

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain('author=Frank%20Herbert');
    });

    it('returns empty array when no docs', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const results = await provider.searchByTitle('NothingFound');
      expect(results).toEqual([]);
    });

    it('returns empty array on error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));

      const results = await provider.searchByTitle('Error');
      expect(results).toEqual([]);
    });
  });

  describe('getBookDetails', () => {
    it('uses works endpoint for work IDs', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          title: 'Dune',
          description: 'A great book',
          first_publish_year: 1965,
          key: '/works/OL893415W',
        }),
      });

      await provider.getBookDetails('OL893415W');

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/works/OL893415W.json');
    });

    it('returns mapped BookData', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          title: 'Dune',
          description: { value: 'Epic sci-fi novel' },
          first_publish_year: 1965,
          number_of_pages: 412,
          key: '/works/OL893415W',
          subjects: ['Science Fiction', 'Epic'],
          cover_i: 12345,
        }),
      });

      const result = await provider.getBookDetails('OL893415W');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Dune');
      expect(result!.description).toBe('Epic sci-fi novel');
      expect(result!.pageCount).toBe(412);
    });

    it('extracts cover URL from cover_i', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          title: 'Test',
          key: '/works/OL1W',
          cover_i: 54321,
        }),
      });

      const result = await provider.getBookDetails('OL1W');
      expect(result!.coverUrl).toBe('https://covers.openlibrary.org/b/id/54321-M.jpg');
    });

    it('extracts cover URL from covers array', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          title: 'Test',
          key: '/works/OL1W',
          covers: [99999, 88888],
        }),
      });

      const result = await provider.getBookDetails('OL1W');
      expect(result!.coverUrl).toBe('https://covers.openlibrary.org/b/id/99999-M.jpg');
    });

    it('returns null on error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));

      const result = await provider.getBookDetails('OLfail');
      expect(result).toBeNull();
    });

    it('returns null when response is not ok', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await provider.getBookDetails('OLmiss');
      expect(result).toBeNull();
    });
  });

  describe('book data mapping', () => {
    it('handles missing author gracefully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          title: 'Anonymous Work',
          key: '/works/OL999W',
        }),
      });

      const result = await provider.getBookDetails('OL999W');
      expect(result!.author).toBe('Unknown');
    });

    it('handles missing title gracefully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          key: '/works/OL888W',
        }),
      });

      const result = await provider.getBookDetails('OL888W');
      expect(result!.title).toBe('Unknown Title');
    });

    it('slices subjects to max 5', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          title: 'Test',
          key: '/works/OL1W',
          subject: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        }),
      });

      const result = await provider.getBookDetails('OL1W');
      expect(result!.categories).toHaveLength(5);
    });

    it('falls back to string description', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          title: 'Test',
          key: '/works/OL1W',
          description: 'A simple description',
        }),
      });

      const result = await provider.getBookDetails('OL1W');
      expect(result!.description).toBe('A simple description');
    });

    it('uses publish_date string directly', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          title: 'Test',
          key: '/works/OL1W',
          publish_date: 'March 2020',
        }),
      });

      const result = await provider.getBookDetails('OL1W');
      expect(result!.publishedDate).toBe('March 2020');
    });

    it('falls back to first_publish_year', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          title: 'Test',
          key: '/works/OL1W',
          first_publish_year: 2020,
        }),
      });

      const result = await provider.getBookDetails('OL1W');
      expect(result!.publishedDate).toBe('2020');
    });
  });

  describe('searchByAuthorKey', () => {
    it('returns mapped docs and total from the search response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          numFound: 2,
          docs: [
            { title: 'Dune', author_name: ['Frank Herbert'], key: '/works/OL1W', first_publish_year: 1965 },
            { title: 'Dune Messiah', author_name: ['Frank Herbert'], key: '/works/OL2W', first_publish_year: 1969 },
          ],
        }),
      });

      const result = await provider.searchByAuthorKey('OL23919A');

      expect(result).not.toBeNull();
      expect(result!.total).toBe(2);
      expect(result!.docs).toHaveLength(2);
      expect(result!.docs[0].title).toBe('Dune');
      expect(result!.docs[0].identifiers['openlibrary']).toBe('/works/OL1W');
    });

    it('builds the query with page and limit', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ numFound: 0, docs: [] }),
      });

      await provider.searchByAuthorKey('OL23919A', 3, 50);

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain('author_key=OL23919A');
      expect(calledUrl).toContain('page=3');
      expect(calledUrl).toContain('limit=50');
    });

    it('returns null when response is not ok', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      expect(await provider.searchByAuthorKey('OLnone')).toBeNull();
    });

    it('returns null on network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));
      expect(await provider.searchByAuthorKey('OL1')).toBeNull();
    });
  });
});
