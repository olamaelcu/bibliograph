import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleBooksProvider } from './googlebooks.js';

describe('GoogleBooksProvider', () => {
  let provider: GoogleBooksProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new GoogleBooksProvider('test-api-key');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getName', () => {
    it('returns "Google Books"', () => {
      expect(provider.getName()).toBe('Google Books');
    });
  });

  describe('searchByIsbn', () => {
    it('returns null when no items found', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await provider.searchByIsbn('9781234567890');
      expect(result).toBeNull();
    });

    it('returns mapped BookData on success', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          items: [{
            id: 'abc123',
            volumeInfo: {
              title: 'Dune',
              authors: ['Frank Herbert'],
              publishedDate: '1965-08-01',
              description: 'Epic sci-fi',
              pageCount: 412,
              language: 'en',
              publisher: 'Chilton Books',
              categories: ['Fiction', 'Science Fiction'],
              industryIdentifiers: [
                { type: 'ISBN_10', identifier: '0441172717' },
                { type: 'ISBN_13', identifier: '9780441172719' },
              ],
              imageLinks: {
                thumbnail: 'http://example.com/thumb.jpg',
              },
            },
          }],
        }),
      });

      const result = await provider.searchByIsbn('9780441172719');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Dune');
      expect(result!.author).toBe('Frank Herbert');
      expect(result!.isbn10).toBe('0441172717');
      expect(result!.isbn13).toBe('9780441172719');
      expect(result!.publishedDate).toBe('1965-08-01');
      expect(result!.description).toBe('Epic sci-fi');
      expect(result!.pageCount).toBe(412);
      expect(result!.language).toBe('en');
      expect(result!.publisher).toBe('Chilton Books');
      expect(result!.categories).toEqual(['Fiction', 'Science Fiction']);
      expect(result!.coverUrl).toBe('http://example.com/thumb.jpg');
      expect(result!.sourceProvider).toBe('googleBooks');
    });

    it('returns null on error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));
      const result = await provider.searchByIsbn('9780000000001');
      expect(result).toBeNull();
    });

    it('returns null when response is not ok', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
      const result = await provider.searchByIsbn('9780000000001');
      expect(result).toBeNull();
    });
  });

  describe('searchByTitle', () => {
    it('returns results when found', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          items: [
            {
              id: 'abc',
              volumeInfo: {
                title: 'Dune',
                authors: ['Frank Herbert'],
                publishedDate: '1965',
              },
            },
          ],
        }),
      });

      const results = await provider.searchByTitle('Dune');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Dune');
    });

    it('includes author in query', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [] }),
      });

      await provider.searchByTitle('Dune', 'Frank Herbert');

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain('inauthor:Frank%20Herbert');
    });

    it('returns empty array on error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));
      const results = await provider.searchByTitle('Error');
      expect(results).toEqual([]);
    });
  });

  describe('getBookDetails', () => {
    it('returns mapped BookData by ID', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: 'abc123',
          volumeInfo: {
            title: 'Dune',
            authors: ['Frank Herbert'],
            publishedDate: '1965',
          },
        }),
      });

      const result = await provider.getBookDetails('abc123');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Dune');
      expect(result!.identifiers['googleBooks']).toBe('abc123');
    });

    it('returns null on error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));
      const result = await provider.getBookDetails('bad');
      expect(result).toBeNull();
    });

    it('returns null when response not ok', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      const result = await provider.getBookDetails('miss');
      expect(result).toBeNull();
    });
  });

  describe('book data mapping', () => {
    it('handles missing volumeInfo gracefully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'min' }),
      });

      const result = await provider.getBookDetails('min');
      expect(result!.title).toBe('Unknown Title');
      expect(result!.author).toBe('Unknown');
    });

    it('joins multiple authors with commas', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          volumeInfo: {
            title: 'Collab Book',
            authors: ['First Author', 'Second Author'],
          },
        }),
      });

      const result = await provider.getBookDetails('collab');
      expect(result!.author).toBe('First Author, Second Author');
    });

    it('falls back to smallThumbnail when thumbnail is missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          volumeInfo: {
            title: 'Test',
            imageLinks: { smallThumbnail: 'http://small.example.com' },
          },
        }),
      });

      const result = await provider.getBookDetails('img');
      expect(result!.coverUrl).toBe('http://small.example.com');
    });
  });

  describe('searchByAuthorName', () => {
    it('returns mapped items and totalItems', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          totalItems: 2,
          items: [
            { id: 'v1', volumeInfo: { title: 'Dune', authors: ['Frank Herbert'], publishedDate: '1965' } },
            { id: 'v2', volumeInfo: { title: 'Dune Messiah', authors: ['Frank Herbert'], publishedDate: '1969' } },
          ],
        }),
      });

      const result = await provider.searchByAuthorName('Frank Herbert');

      expect(result).not.toBeNull();
      expect(result!.totalItems).toBe(2);
      expect(result!.items).toHaveLength(2);
      expect(result!.items[0].title).toBe('Dune');
      expect(result!.items[0].identifiers['googleBooks']).toBe('v1');
    });

    it('builds query with inauthor, startIndex, maxResults, and key', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ totalItems: 0, items: [] }),
      });

      await provider.searchByAuthorName('Frank Herbert', 40, 40);

      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain('inauthor:Frank%20Herbert');
      expect(calledUrl).toContain('startIndex=40');
      expect(calledUrl).toContain('maxResults=40');
      expect(calledUrl).toContain('key=test-api-key');
    });

    it('returns empty result when no items', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ totalItems: 0 }),
      });

      const result = await provider.searchByAuthorName('Nobody');

      expect(result).not.toBeNull();
      expect(result!.items).toEqual([]);
      expect(result!.totalItems).toBe(0);
    });

    it('returns null on error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));
      expect(await provider.searchByAuthorName('X')).toBeNull();
    });

    it('returns null when response not ok', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
      expect(await provider.searchByAuthorName('X')).toBeNull();
    });
  });
});
