import { expect, test } from 'vitest';

import {
  candidateFromEdition,
  candidateFromSearchDocument,
  contributorFromAuthorDocument,
  createOpenLibrary,
  openLibraryBookKey,
  parseOpenLibraryDate,
  SEARCH_LIMIT,
  subjectsFromWork
} from '../lib/providers/openlibrary.js';
import { createProviders } from '../lib/providers/index.js';
import { candidateKey } from '../lib/util.js';

const ISBN13 = '9780441478125';
const ISBN10 = '0441478123';
const AUTHOR_KEY = 'OL789A';

const editionDocument = {
  key: '/books/OL123M',
  title: 'The Left Hand of Darkness',
  subtitle: 'A Novel',
  works: [{ key: '/works/OL456W' }],
  authors: [{ key: `/authors/${AUTHOR_KEY}` }],
  isbn_13: [ISBN13],
  isbn_10: [ISBN10],
  publish_date: '1969',
  number_of_pages: 304,
  physical_format: 'Paperback',
  publishers: ['Ace'],
  languages: [{ key: '/languages/eng' }],
  covers: [12345],
  series: ['The Hainish Cycle'],
  description: 'An edition description.'
};

const authorDocument = {
  key: `/authors/${AUTHOR_KEY}`,
  name: 'Ursula K. Le Guin',
  birth_date: 'October 21, 1929',
  death_date: '2018-01-22',
  bio: { type: '/type/text', value: '<p>An American author.</p>' },
  photos: [555],
  remote_ids: {
    wikidata: 'Q240133',
    viaf: '123456',
    isni: '0000 0001 2123 4567',
    goodreads: '874602',
    unseen: 'ignored'
  }
};

const searchDocument = {
  key: '/works/OL456W',
  title: 'The Left Hand of Darkness',
  subtitle: 'A Novel',
  author_name: ['Ursula K. Le Guin'],
  author_key: [AUTHOR_KEY],
  first_publish_year: 1969,
  isbn: [ISBN10, ISBN13],
  edition_key: ['OL123M'],
  language: ['eng'],
  cover_i: 12345,
  publisher: ['Ace'],
  number_of_pages_median: 304
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function fakeServer(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      return handler(parsed);
    }
  };
}

function openLibrary({ handler }) {
  const server = fakeServer(handler);
  const provider = createOpenLibrary({
    baseUrl: 'https://openlibrary.test',
    fetchImpl: server.fetchImpl
  });
  return { provider, calls: server.calls };
}

test('parses only unambiguous full OpenLibrary dates', () => {
  expect(parseOpenLibraryDate('1965-07-31')).toBe('1965-07-31');
  expect(parseOpenLibraryDate('1965-7-1')).toBe('1965-07-01');
  expect(parseOpenLibraryDate('31 July 1965')).toBe('1965-07-31');
  expect(parseOpenLibraryDate('July 31, 1965')).toBe('1965-07-31');
  expect(parseOpenLibraryDate('Jan. 2, 1900')).toBe('1900-01-02');
  expect(parseOpenLibraryDate('1965'), 'a year is partial').toBe(undefined);
  expect(parseOpenLibraryDate('July 1965'), 'a month is partial').toBe(undefined);
  expect(parseOpenLibraryDate('07/08/1965'), 'numeric order is ambiguous').toBe(undefined);
  expect(parseOpenLibraryDate('1965-02-30'), 'impossible calendar day').toBe(undefined);
  expect(parseOpenLibraryDate('circa 1965')).toBe(undefined);
  expect(parseOpenLibraryDate(undefined)).toBe(undefined);
});

test('normalizes an OpenLibrary search document into an edition candidate', () => {
  const candidate = candidateFromSearchDocument(searchDocument);
  expect(candidate.title).toBe('The Left Hand of Darkness');
  expect(candidate.subtitle).toBe('A Novel');
  expect(candidate.identifiers).toEqual([
    { issuer: 'openlibrary', value: 'OL123M' },
    { issuer: 'isbn13', value: ISBN13 },
    { issuer: 'isbn10', value: ISBN10 }
  ]);
  expect(candidate.publishedDate).toBe('1969');
  expect(candidate.language).toBe('eng');
  expect(candidate.pages).toBe(304);
  expect(candidate.coverUrl).toBe('https://covers.openlibrary.org/b/id/12345-L.jpg');
  expect(candidate.publisher.name).toBe('Ace');
  expect(candidate.contributors).toEqual([
    {
      name: 'Ursula K. Le Guin',
      role: 'A01',
      identifiers: [{ issuer: 'openlibrary', value: AUTHOR_KEY }]
    }
  ]);
  expect(candidateKey(candidate)).toBe(`isbn:${ISBN13}`);
});

test('search uses the bounded fields query and skips malformed documents', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) => {
      if (url.pathname === '/search.json') {
        return jsonResponse({
          docs: [
            searchDocument,
            { title: 'No identity at all' },
            { key: '/works/OL999W', title: 'No edition key' }
          ]
        });
      }
      return jsonResponse({}, 404);
    }
  });

  const candidates = await provider.search({ title: 'left hand', author: 'le guin' });

  const searchCall = calls.find((url) => url.pathname === '/search.json');
  expect(searchCall.searchParams.get('q')).toBe('left hand le guin');
  expect(searchCall.searchParams.get('limit')).toBe(String(SEARCH_LIMIT));
  expect(searchCall.searchParams.get('fields')).toMatch(/edition_key/);
  expect(candidates.length).toBe(2);
  expect(candidates[0].title).toBe('The Left Hand of Darkness');
  expect(candidates[1].identifiers).toEqual([{ issuer: 'openlibrary', value: 'OL999W' }]);
});

test('normalizes an edition with work and author expansion', async () => {
  const withoutDescription = { ...editionDocument, description: undefined };
  const { provider, calls } = openLibrary({
    handler: (url) => {
      if (url.pathname === `/isbn/${ISBN13}.json`) return jsonResponse(withoutDescription);
      if (url.pathname === '/works/OL456W.json') {
        return jsonResponse({ description: { value: '<p>Work description.</p>' } });
      }
      if (url.pathname === `/authors/${AUTHOR_KEY}.json`) return jsonResponse(authorDocument);
      return jsonResponse({}, 404);
    }
  });

  const candidates = await provider.byIsbn(ISBN13);

  expect(candidates.length).toBe(1);
  expect(candidates[0].description).toBe('Work description.');
  expect(candidates[0].contributors[0].name).toBe('Ursula K. Le Guin');
  expect(candidates[0].contributors[0].description).toBe('An American author.');
  expect(candidates[0].coverUrl).toBe('https://covers.openlibrary.org/b/id/12345-L.jpg');
  expect(candidates[0].format).toBe('Paperback');
  expect(candidates[0].series.name).toBe('The Hainish Cycle');
  expect(candidates[0].language).toBe('eng');
  expect(candidates[0].identifiers).toEqual([
      { issuer: 'openlibrary', value: 'OL123M' },
      { issuer: 'isbn13', value: ISBN13 },
      { issuer: 'isbn10', value: ISBN10 }
    ]);
  expect(calls.some((url) => url.pathname === `/isbn/${ISBN13}.json`)).toBeTruthy();
});

test('byIdentifier resolves edition and work keys, deduping work editions', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) => {
      if (url.pathname === '/books/OL123M.json') return jsonResponse(editionDocument);
      if (url.pathname === '/works/OL456W/editions.json') {
        return jsonResponse({
          entries: [
            editionDocument,
            { ...editionDocument, key: '/books/OL124M', isbn_13: ['9780306406157'] },
            { ...editionDocument, key: '/books/OL124M', isbn_13: ['9780306406157'] }
          ]
        });
      }
      if (url.pathname === `/authors/${AUTHOR_KEY}.json`) return jsonResponse(authorDocument);
      return jsonResponse({}, 404);
    }
  });

  expect(openLibraryBookKey('/books/OL123M')).toBe('OL123M');
  expect(openLibraryBookKey('OL456W')).toBe('OL456W');
  expect(openLibraryBookKey('/authors/OL789A')).toBe(undefined);

  const edition = await provider.byIdentifier('OL123M');
  expect(edition.length).toBe(1);
  expect(edition[0].identifiers[0].value).toBe('OL123M');

  const work = await provider.byIdentifier('/works/OL456W');
  expect(work.length, 'the duplicate edition is merged').toBe(2);
  expect(work.map((candidate) => candidate.identifiers.find((id) => id.issuer === 'openlibrary').value)).toEqual(['OL123M', 'OL124M']);
  expect(calls.some((url) => url.pathname === '/works/OL456W/editions.json')).toBeTruthy();
});

test('byIsbn answers empty for a 404 and rejects a provider failure', async () => {
  const missing = openLibrary({ handler: () => jsonResponse({}, 404) });
  expect(await missing.provider.byIsbn(ISBN13)).toEqual([]);

  const broken = openLibrary({ handler: () => jsonResponse({ message: 'boom' }, 500) });
  await expect(() => broken.provider.byIsbn(ISBN13)).rejects.toThrow(/answered 500/);
});

test('searches contributors and expands author detail', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) => {
      if (url.pathname === '/search/authors.json') {
        return jsonResponse({
          numFound: 2,
          docs: [
            { key: AUTHOR_KEY, name: 'Ursula K. Le Guin', birth_date: '1929' },
            { key: 'OL790A', name: 'Partial Date Author', birth_date: 'July 1965' }
          ]
        });
      }
      if (url.pathname === `/authors/${AUTHOR_KEY}.json`) return jsonResponse(authorDocument);
      return jsonResponse({}, 404);
    }
  });

  const contributors = await provider.searchContributors('le guin', { limit: 500 });
  const searchCall = calls.find((url) => url.pathname === '/search/authors.json');
  expect(searchCall.searchParams.get('q')).toBe('le guin');
  expect(searchCall.searchParams.get('limit'), 'the provider caps the limit').toBe('50');
  expect(contributors.length).toBe(2);
  expect(contributors[0].identifiers).toEqual([{ issuer: 'openlibrary', value: AUTHOR_KEY }]);
  expect(contributors[0].born, 'a bare year is omitted').toBe(undefined);
  expect(contributors[1].born, 'a month/year is omitted').toBe(undefined);

  const detail = await provider.author(`/authors/${AUTHOR_KEY}`);
  expect(detail).toEqual({
    displayName: 'Ursula K. Le Guin',
    identifiers: [
      { issuer: 'openlibrary', value: AUTHOR_KEY },
      { issuer: 'wikidata', value: 'Q240133' },
      { issuer: 'viaf', value: '123456' },
      { issuer: 'isni', value: '0000 0001 2123 4567' },
      { issuer: 'goodreads', value: '874602' }
    ],
    key: AUTHOR_KEY,
    description: 'An American author.',
    imageUrl: 'https://covers.openlibrary.org/a/id/555-L.jpg',
    born: '1929-10-21',
    died: '2018-01-22'
  });
  expect(detail.role, 'contributor candidates never carry edition roles').toBe(undefined);
});

test('contributor normalization keeps partial dates out', () => {
  const contributor = contributorFromAuthorDocument({
    key: 'OL1A',
    name: 'No Full Dates',
    birth_date: '1900',
    death_date: '1970-06',
    remote_ids: {}
  });
  expect(contributor.displayName).toBe('No Full Dates');
  expect(contributor.born).toBe(undefined);
  expect(contributor.died).toBe(undefined);
  expect(contributor.identifiers).toEqual([{ issuer: 'openlibrary', value: 'OL1A' }]);
  expect(contributorFromAuthorDocument({ key: 'OL1A' })).toBe(undefined);
});

test('candidateFromEdition accepts missing optional fields', () => {
  const candidate = candidateFromEdition({
    key: '/books/OL1M',
    title: 'Minimal Edition',
    isbn_13: ['9780306406157']
  });
  expect(candidate).toEqual({
    title: 'Minimal Edition',
    identifiers: [
      { issuer: 'openlibrary', value: 'OL1M' },
      { issuer: 'isbn13', value: '9780306406157' }
    ],
    contributors: []
  });
  expect(candidateFromEdition({ title: 'No identity' })).toBe(undefined);
});

test('candidateFromEdition takes the contributor bio from author detail', () => {
  const candidate = candidateFromEdition(
    {
      key: '/books/OL2M',
      title: 'Bio Edition',
      isbn_13: ['9780306406157'],
      authors: [{ key: `/authors/${AUTHOR_KEY}` }]
    },
    {
      authorDetails: new Map([
        [AUTHOR_KEY, { displayName: 'Bio Author', description: 'A bio.' }]
      ])
    }
  );

  expect(candidate.contributors).toEqual([
    {
      name: 'Bio Author',
      role: 'A01',
      description: 'A bio.',
      identifiers: [{ issuer: 'openlibrary', value: AUTHOR_KEY }]
    }
  ]);
});

test('describeContributors fills only a missing bio', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) => {
      if (url.pathname === `/authors/${AUTHOR_KEY}.json`) return jsonResponse(authorDocument);
      return jsonResponse({}, 404);
    }
  });
  const authorCalls = () => calls.filter((url) => url.pathname.startsWith('/authors/'));

  const contributors = [
    { name: 'No Bio', role: 'A01', identifiers: [{ issuer: 'openlibrary', value: AUTHOR_KEY }] },
    {
      name: 'Already Described',
      role: 'A01',
      description: 'Kept.',
      identifiers: [{ issuer: 'openlibrary', value: AUTHOR_KEY }]
    },
    { name: 'No Identifiers', role: 'A01' },
    {
      name: 'Unknown Author',
      role: 'A01',
      identifiers: [{ issuer: 'openlibrary', value: 'OL999A' }]
    }
  ];

  const described = await provider.describeContributors(contributors);
  expect(described[0].description).toBe('An American author.');
  expect(described[1].description).toBe('Kept.');
  expect(described[1], 'a described candidate is untouched').toBe(contributors[1]);
  expect(described[2].description).toBe(undefined);
  expect(described[3].description, 'a failed lookup is not fatal').toBe(undefined);
  expect(authorCalls().map((url) => url.pathname)).toEqual([`/authors/${AUTHOR_KEY}.json`, '/authors/OL999A.json']);

  const skipped = await provider.describeContributors(contributors, { limit: 0 });
  expect(skipped).toEqual(contributors);
  expect(authorCalls().length, 'limit 0 makes no author request').toBe(2);
});

test('provider chain tries Goodreads before OpenLibrary', async () => {
  const order = [];
  const base = 'https://provider.test';
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/google/volumes') {
      order.push('googlebooks');
      return jsonResponse({ totalItems: 0, items: [] });
    }
    if (parsed.pathname === '/openlibrary/search.json') {
      order.push('openlibrary');
      return jsonResponse({ docs: [searchDocument] });
    }
    if (parsed.pathname === '/goodreads/search') {
      order.push('goodreads');
      return new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    }
    return jsonResponse({}, 404);
  };

  const providers = createProviders({
    env: {
      GOOGLE_BOOKS_BASE_URL: `${base}/google`,
      OPENLIBRARY_BASE_URL: `${base}/openlibrary`,
      GOODREADS_BASE_URL: `${base}/goodreads`
    },
    fetchImpl
  });

  const candidates = await providers.search({ title: 'left hand' });
  expect(order).toEqual(['googlebooks', 'goodreads', 'openlibrary']);
  expect(candidates[0].title).toBe('The Left Hand of Darkness');
  expect(providers.resilience.openlibrary.state).toBe('closed');
  expect(providers.metrics
      .snapshot()
      .breaker.some((row) => row.provider === 'openlibrary' && row.state === 'closed')).toBeTruthy();
});

test('the ISBN chain tries Goodreads before OpenLibrary', async () => {
  const order = [];
  const base = 'https://provider.test';
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/google/volumes') {
      order.push('googlebooks');
      return jsonResponse({ totalItems: 0, items: [] });
    }
    if (parsed.pathname === `/openlibrary/isbn/${ISBN13}.json`) {
      order.push('openlibrary');
      return jsonResponse(editionDocument);
    }
    if (parsed.pathname === '/openlibrary/works/OL456W.json') {
      return jsonResponse({ description: 'Work description.' });
    }
    if (parsed.pathname === `/openlibrary/authors/${AUTHOR_KEY}.json`) {
      return jsonResponse(authorDocument);
    }
    if (parsed.pathname.startsWith('/goodreads/')) {
      // The ISBN page answers empty, so the provider falls back to search;
      // the chain position is recorded once at the search step.
      if (parsed.pathname === '/goodreads/search') order.push('goodreads');
      return new Response('<html></html>', { status: 200 });
    }
    return jsonResponse({}, 404);
  };

  const providers = createProviders({
    env: {
      GOOGLE_BOOKS_BASE_URL: `${base}/google`,
      OPENLIBRARY_BASE_URL: `${base}/openlibrary`,
      GOODREADS_BASE_URL: `${base}/goodreads`
    },
    fetchImpl
  });

  const candidates = await providers.resolve({ issuer: 'isbn13', value: ISBN13 });
  expect(order).toEqual(['googlebooks', 'goodreads', 'openlibrary']);
  expect(candidates[0].title).toBe('The Left Hand of Darkness');
});

test('a Goodreads candidate stops the chain before OpenLibrary', async () => {
  const order = [];
  const base = 'https://provider.test';
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/google/volumes') {
      order.push('googlebooks');
      return jsonResponse({ totalItems: 0, items: [] });
    }
    if (parsed.pathname === '/goodreads/search') {
      order.push('goodreads');
      return new Response(
        `<table><tr itemscope>
<td><a href="/book/show/1"><img class="bookCover" src="https://img.example/1.jpg" /></a></td>
<td><a class="bookTitle" href="/book/show/1"><span itemprop="name">Goodreads First</span></a></td>
</tr></table>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }
    if (parsed.pathname === '/openlibrary/search.json') order.push('openlibrary');
    return jsonResponse({}, 404);
  };

  const providers = createProviders({
    env: {
      GOOGLE_BOOKS_BASE_URL: `${base}/google`,
      OPENLIBRARY_BASE_URL: `${base}/openlibrary`,
      GOODREADS_BASE_URL: `${base}/goodreads`
    },
    fetchImpl
  });

  const candidates = await providers.search({ title: 'goodreads wins' });
  expect(order).toEqual(['googlebooks', 'goodreads']);
  expect(candidates.map((candidate) => candidate.title)).toEqual(['Goodreads First']);
});

test('a Google candidate still stops the chain before Goodreads and OpenLibrary', async () => {
  const called = [];
  const base = 'https://provider.test';
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    called.push(parsed.pathname);
    if (parsed.pathname === '/google/volumes') {
      return jsonResponse({
        totalItems: 1,
        items: [
          {
            id: 'google-wins',
            volumeInfo: {
              title: 'Google First',
              industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780306406157' }]
            }
          }
        ]
      });
    }
    return jsonResponse({}, 404);
  };

  const providers = createProviders({
    env: {
      GOOGLE_BOOKS_BASE_URL: `${base}/google`,
      OPENLIBRARY_BASE_URL: `${base}/openlibrary`,
      GOODREADS_BASE_URL: `${base}/goodreads`
    },
    fetchImpl
  });

  const candidates = await providers.search({ title: 'google wins' });
  expect(candidates.map((candidate) => candidate.title)).toEqual(['Google First']);
  expect(called).toEqual(['/google/volumes']);
});

test('openlibrary identifiers resolve directly', async () => {
  const called = [];
  const base = 'https://provider.test';
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    called.push(parsed.pathname);
    if (parsed.pathname === '/openlibrary/books/OL123M.json') return jsonResponse(editionDocument);
    if (parsed.pathname === '/openlibrary/works/OL456W.json') {
      return jsonResponse({ description: 'Work description.' });
    }
    if (parsed.pathname === `/openlibrary/authors/${AUTHOR_KEY}.json`) {
      return jsonResponse(authorDocument);
    }
    return jsonResponse({}, 404);
  };

  const providers = createProviders({
    env: {
      OPENLIBRARY_BASE_URL: `${base}/openlibrary`,
      GOOGLE_BOOKS_BASE_URL: `${base}/google`,
      GOODREADS_BASE_URL: `${base}/goodreads`
    },
    fetchImpl
  });

  const candidates = await providers.resolve({ issuer: 'openlibrary', value: 'OL123M' });
  expect(candidates[0].title).toBe('The Left Hand of Darkness');
  expect(called.includes('/openlibrary/books/OL123M.json')).toBeTruthy();
  expect(!called.some((path) => path.startsWith('/google/'))).toBeTruthy();
  expect(!called.some((path) => path.startsWith('/goodreads/'))).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Genres: subjects live on the work, so every path ends at a work document
// ---------------------------------------------------------------------------

const DUNE_WORK = {
  key: '/works/OL893414W',
  title: 'Dune',
  subjects: ['Fiction', 'Science fiction', 'Dune (Imaginary place)', 'nyt:mass-market-monthly=2021-11-07']
};

test('subjectsFromWork keeps only the non-empty strings', () => {
  expect(subjectsFromWork(DUNE_WORK)).toEqual(DUNE_WORK.subjects);
  expect(subjectsFromWork({ subjects: ['Fiction', '', '   ', 42, null] })).toEqual(['Fiction']);
  expect(subjectsFromWork({ subjects: 'Fiction' }), 'a bare string is not a list').toEqual([]);
  expect(subjectsFromWork({})).toEqual([]);
  expect(subjectsFromWork(undefined)).toEqual([]);
});

test('genresForEdition resolves a work key in one request', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) =>
      url.pathname === '/works/OL893414W.json' ? jsonResponse(DUNE_WORK) : jsonResponse({}, 404)
  });

  const subjects = await provider.genresForEdition([
    { issuer: 'openlibrary', value: 'OL893414W' }
  ]);

  expect(subjects).toEqual(DUNE_WORK.subjects);
  expect(calls.map((call) => call.pathname)).toEqual(['/works/OL893414W.json']);
});

test('genresForEdition reaches the work through an edition key', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) => {
      if (url.pathname === '/books/OL123M.json') {
        return jsonResponse({ key: '/books/OL123M', works: [{ key: '/works/OL893414W' }] });
      }
      if (url.pathname === '/works/OL893414W.json') return jsonResponse(DUNE_WORK);
      return jsonResponse({}, 404);
    }
  });

  const subjects = await provider.genresForEdition([{ issuer: 'openlibrary', value: 'OL123M' }]);

  expect(subjects[1]).toBe('Science fiction');
  expect(calls.map((call) => call.pathname)).toEqual([
    '/books/OL123M.json',
    '/works/OL893414W.json'
  ]);
});

test('genresForEdition reaches the work through an ISBN', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) => {
      if (url.pathname === `/isbn/${ISBN13}.json`) {
        return jsonResponse({ key: '/books/OL123M', works: [{ key: '/works/OL893414W' }] });
      }
      if (url.pathname === '/works/OL893414W.json') return jsonResponse(DUNE_WORK);
      return jsonResponse({}, 404);
    }
  });

  const subjects = await provider.genresForEdition([
    { issuer: 'isbn13', value: ISBN13 },
    { issuer: 'goodreads', value: '234225' }
  ]);

  expect(subjects[0]).toBe('Fiction');
  expect(calls.map((call) => call.pathname)).toEqual([
    `/isbn/${ISBN13}.json`,
    '/works/OL893414W.json'
  ]);
});

test('genresForEdition follows exactly one work redirect', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) => {
      if (url.pathname === '/works/OL893415W.json') {
        return jsonResponse({ type: { key: '/type/redirect' }, location: '/works/OL893414W' });
      }
      if (url.pathname === '/works/OL893414W.json') return jsonResponse(DUNE_WORK);
      return jsonResponse({}, 404);
    }
  });

  expect(await provider.genresForEdition([{ issuer: 'openlibrary', value: 'OL893415W' }])).toEqual(DUNE_WORK.subjects);
  expect(calls.map((call) => call.pathname)).toEqual([
    '/works/OL893415W.json',
    '/works/OL893414W.json'
  ]);
});

test('genresForEdition answers nothing for a second redirect, a 404 or no identifier', async () => {
  const redirecting = openLibrary({
    handler: (url) => {
      if (url.pathname === '/works/OL893414W.json') {
        return jsonResponse({ type: { key: '/type/redirect' }, location: '/works/OL893416W' });
      }
      if (url.pathname === '/works/OL893416W.json') {
        return jsonResponse({ type: { key: '/type/redirect' }, location: '/works/OL893417W' });
      }
      return jsonResponse({}, 404);
    }
  });
  expect(await redirecting.provider.genresForEdition([{ issuer: 'openlibrary', value: 'OL893414W' }]), 'a redirect chain is not chased').toEqual([]);
  expect(redirecting.calls.length, 'the second hop was attempted once, not followed again').toBe(2);

  const missing = openLibrary({ handler: () => jsonResponse({}, 404) });
  expect(await missing.provider.genresForEdition([{ issuer: 'openlibrary', value: 'OL404W' }])).toEqual([]);

  const empty = openLibrary({ handler: () => jsonResponse({}, 404) });
  expect(await empty.provider.genresForEdition([])).toEqual([]);
  expect(await empty.provider.genresForEdition()).toEqual([]);
  expect(empty.calls.length, 'no identifier means no request').toBe(0);
});

test('coverForEdition reads the cover of the edition an ISBN resolves to', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) =>
      url.pathname === `/isbn/${ISBN13}.json`
        ? jsonResponse({ key: '/books/OL123M', covers: [12345] })
        : jsonResponse({}, 404)
  });

  const cover = await provider.coverForEdition([
    { issuer: 'isbn13', value: ISBN13 },
    { issuer: 'goodreads', value: '234225' }
  ]);

  expect(cover).toBe('https://covers.openlibrary.org/b/id/12345-L.jpg');
  expect(calls.map((call) => call.pathname)).toEqual([`/isbn/${ISBN13}.json`]);
});

test('coverForEdition treats a missing or non-positive cover as no cover', async () => {
  for (const covers of [undefined, [-1], [0], [], null]) {
    const { provider } = openLibrary({
      handler: () => jsonResponse({ key: '/books/OL123M', covers })
    });
    expect(await provider.coverForEdition([{ issuer: 'isbn13', value: ISBN13 }]), `covers ${JSON.stringify(covers)}`).toBe(undefined);
  }
});

test('coverForEdition reads an OL…M identifier edition without an ISBN', async () => {
  const { provider, calls } = openLibrary({
    handler: (url) =>
      url.pathname === '/books/OL123M.json'
        ? jsonResponse({ key: '/books/OL123M', covers: [777] })
        : jsonResponse({}, 404)
  });

  const cover = await provider.coverForEdition([{ issuer: 'openlibrary', value: 'OL123M' }]);

  expect(cover).toBe('https://covers.openlibrary.org/b/id/777-L.jpg');
  expect(calls.map((call) => call.pathname)).toEqual(['/books/OL123M.json']);
});

test('coverForEdition makes no request for a bag with no usable identifier', async () => {
  const { provider, calls } = openLibrary({ handler: () => jsonResponse({}, 404) });

  expect(await provider.coverForEdition([{ issuer: 'goodreads', value: '234225' }])).toBe(undefined);
  expect(await provider.coverForEdition([])).toBe(undefined);
  expect(await provider.coverForEdition()).toBe(undefined);
  expect(calls.length, 'no usable identifier means no request').toBe(0);
});
