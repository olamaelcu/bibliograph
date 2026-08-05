import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoodreadsProvider } from './goodreads.js';

describe('GoodreadsProvider', () => {
  let provider: GoodreadsProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new GoodreadsProvider();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getName', () => {
    it('returns "Goodreads"', () => {
      expect(provider.getName()).toBe('Goodreads');
    });
  });

  describe('searchByIsbn', () => {
    it('returns null when no results', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      const result = await provider.searchByIsbn('9781234567890');
      expect(result).toBeNull();
    });

    it('returns null when response is not ok', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
      const result = await provider.searchByIsbn('9781234567890');
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));
      const result = await provider.searchByIsbn('9781234567890');
      expect(result).toBeNull();
    });

    it('maps autocomplete JSON to BookData', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          {
            imageUrl: 'https://images.gr-assets.com/books/123._SX50_.jpg',
            bookId: '13496',
            workId: '240806',
            bookUrl: 'https://www.goodreads.com/book/show/13496',
            title: 'A Game of Thrones',
            bookTitleBare: 'A Game of Thrones',
            numPages: 807,
            avgRating: '4.45',
            ratingsCount: 12345,
            author: {
              id: 472310,
              name: 'George R.R. Martin',
              isGoodreadsAuthor: true,
              profileUrl: 'https://www.goodreads.com/author/show/472310',
              worksListUrl: 'https://www.goodreads.com/author/list/472310',
            },
            description: {
              html: '<i>Epic fantasy</i> at its finest.',
              truncated: false,
              fullContentUrl: '',
            },
          },
        ]),
      });

      const result = await provider.searchByIsbn('9780553573404');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('A Game of Thrones');
      expect(result!.author).toBe('George R.R. Martin');
      expect(result!.pageCount).toBe(807);
      expect(result!.description).toBe('Epic fantasy at its finest.');
      expect(result!.coverUrl).toBe('https://images.gr-assets.com/books/123.jpg');
      expect(result!.identifiers['goodreads']).toBe('13496');
      expect(result!.sourceProvider).toBe('goodreads');
    });

    it('sends the isbn as the q parameter', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      await provider.searchByIsbn('9780553573404');
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/book/auto_complete');
      expect(url).toContain('format=json');
      expect(url).toContain('q=9780553573404');
    });
  });
});
