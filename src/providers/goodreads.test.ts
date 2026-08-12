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
      expect(result!.contributors[0]?.name).toBe('George R.R. Martin');
      expect(result!.contributors).toEqual([{ name: 'George R.R. Martin', order: 0 }]);
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

  describe('searchByTitle', () => {
    it('returns empty array on no results', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      const result = await provider.searchByTitle('NothingFound');
      expect(result).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));
      const result = await provider.searchByTitle('Nothing');
      expect(result).toEqual([]);
    });

    it('returns empty array when response is not ok', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
      const result = await provider.searchByTitle('Nothing');
      expect(result).toEqual([]);
    });

    it('maps multiple results', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          {
            imageUrl: 'https://x/a._SY50_.jpg',
            bookId: '1',
            bookTitleBare: 'Dune',
            numPages: 412,
            author: { name: 'Frank Herbert' },
            description: { html: 'Sci-fi classic' },
          },
          {
            imageUrl: 'https://x/b._SY50_.jpg',
            bookId: '2',
            bookTitleBare: 'Dune Messiah',
            numPages: 256,
            author: { name: 'Frank Herbert' },
            description: { html: '' },
          },
        ]),
      });
      const results = await provider.searchByTitle('Dune');
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Dune');
      expect(results[1].title).toBe('Dune Messiah');
    });

    it('builds URL with title only', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      await provider.searchByTitle('Dune');
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('q=Dune');
      expect(url).not.toContain('Frank');
    });

    it('appends author to query when provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      await provider.searchByTitle('Dune', 'Frank Herbert');
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('Dune');
      expect(url).toContain('Frank+Herbert');
    });

    it('skips hits that fail to map (missing bookId)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          { bookTitleBare: 'NoId', author: { name: 'X' } },
          {
            bookId: '99',
            bookTitleBare: 'HasId',
            author: { name: 'Y' },
          },
        ]),
      });
      const results = await provider.searchByTitle('Mixed');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('HasId');
    });
  });

  describe('getBookDetails', () => {
    // Minimal but exercises every field we map. Modeled on bookhive's ApolloState
    // shape from src/scrapers/moreInfo.ts.
    const NEXT_DATA_FIXTURE = {
      props: {
        pageProps: {
          apolloState: {
            ROOT_QUERY: {
              'getBookByLegacyId({"legacyId":"13496"})': { __ref: 'Book:13496' },
            },
            'Book:13496': {
              id: '13496',
              titleComplete: 'A Game of Thrones',
              description: 'A tale of fire and ice.',
              imageUrl: 'https://images.gr-assets.com/books/1566474957._SX318_.jpg',
              webUrl: 'https://www.goodreads.com/book/show/13496',
              details: {
                publicationTime: '1996-08-01T00:00:00.000Z',
                publisher: 'Bantam',
                language: { name: 'English' },
                isbn: '0553573403',
                isbn13: '9780553573404',
                numPages: 807,
              },
              primaryContributorEdge: { node: { __ref: 'Author:472310' } },
              secondaryContributorEdges: [
                { role: 'Author', node: { __ref: 'Author:99999' } },
                { role: 'Illustrator', node: { __ref: 'Author:88888' } },
              ],
              bookGenres: [
                { genre: { name: 'Fantasy' } },
                { genre: { name: 'Fiction' } },
                { genre: { name: 'Epic' } },
              ],
              bookSeries: [
                {
                  userPosition: '1',
                  series: { __ref: 'Series:36249' },
                },
              ],
            },
            'Author:472310': { id: '472310', name: 'George R.R. Martin', description: 'Author bio', profileImageUrl: 'https://x/martin.jpg' },
            'Author:99999': { id: '99999', name: 'Co-Author' },
            'Author:88888': { id: '88888', name: 'Some Illustrator' },
            'Series:36249': { title: 'A Song of Ice and Fire', webUrl: 'https://www.goodreads.com/series/36249' },
          },
        },
      },
    };

    it('returns null when response is not ok (covers 202 WAF)', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 202 });
      const result = await provider.getBookDetails('13496');
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fail'));
      const result = await provider.getBookDetails('13496');
      expect(result).toBeNull();
    });

    it('returns null when HTML has no __NEXT_DATA__', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('<html><body>challenge page</body></html>'),
      });
      const result = await provider.getBookDetails('13496');
      expect(result).toBeNull();
    });

    it('returns null when __NEXT_DATA__ JSON is malformed', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            `<script id="__NEXT_DATA__" type="application/json">not json</script>`,
          ),
      });
      const result = await provider.getBookDetails('13496');
      expect(result).toBeNull();
    });

    it('returns null when apolloState is missing (book gone upstream)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>`,
          ),
      });
      const result = await provider.getBookDetails('13496');
      expect(result).toBeNull();
    });

    it('extracts and maps full __NEXT_DATA__', async () => {
      const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(NEXT_DATA_FIXTURE)}</script>`;
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(html),
      });

      const result = await provider.getBookDetails('13496');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('A Game of Thrones');
      expect(result!.contributors[0]?.name).toBe('George R.R. Martin');
      expect(result!.contributors).toEqual([
        { name: 'George R.R. Martin', order: 0 },
        { name: 'Co-Author', order: 1 },
      ]);
      expect(result!.isbn10).toBe('0553573403');
      expect(result!.isbn13).toBe('9780553573404');
      expect(result!.publishedDate).toBe('1996');
      expect(result!.description).toBe('A tale of fire and ice.');
      expect(result!.pageCount).toBe(807);
      expect(result!.language).toBe('English');
      expect(result!.publisher).toBe('Bantam');
      expect(result!.categories).toEqual(['Fantasy', 'Fiction', 'Epic']);
      expect(result!.coverUrl).toBe('https://images.gr-assets.com/books/1566474957.jpg');
      expect(result!.identifiers['goodreads']).toBe('13496');
      expect(result!.sourceProvider).toBe('goodreads');
    });

    it('filters secondary contributors to Author role only', async () => {
      const fixture = JSON.parse(JSON.stringify(NEXT_DATA_FIXTURE));
      const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(fixture)}</script>`;
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(html),
      });
      const result = await provider.getBookDetails('13496');
      expect(result!.contributors?.map((c) => c.name)).toEqual([
        'George R.R. Martin',
        'Co-Author',
      ]);
      expect(result!.contributors?.map((c) => c.name)).not.toContain('Some Illustrator');
    });

    it('sends browser-like headers and hits /book/show/{id}', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve(
            `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(NEXT_DATA_FIXTURE)}</script>`,
          ),
      });
      await provider.getBookDetails('13496');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://www.goodreads.com/book/show/13496');
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['User-Agent']).toBeDefined();
      expect(headers['Accept-Language']).toBeDefined();
      expect(headers['Referer']).toBe('https://www.goodreads.com/');
    });
  });
});
