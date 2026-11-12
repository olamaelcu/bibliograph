import test from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateFromEdition,
  candidateFromSearchDocument,
  contributorFromAuthorDocument,
  createOpenLibrary,
  openLibraryBookKey,
  parseOpenLibraryDate,
  SEARCH_LIMIT
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
  assert.equal(parseOpenLibraryDate('1965-07-31'), '1965-07-31');
  assert.equal(parseOpenLibraryDate('1965-7-1'), '1965-07-01');
  assert.equal(parseOpenLibraryDate('31 July 1965'), '1965-07-31');
  assert.equal(parseOpenLibraryDate('July 31, 1965'), '1965-07-31');
  assert.equal(parseOpenLibraryDate('Jan. 2, 1900'), '1900-01-02');
  assert.equal(parseOpenLibraryDate('1965'), undefined, 'a year is partial');
  assert.equal(parseOpenLibraryDate('July 1965'), undefined, 'a month is partial');
  assert.equal(parseOpenLibraryDate('07/08/1965'), undefined, 'numeric order is ambiguous');
  assert.equal(parseOpenLibraryDate('1965-02-30'), undefined, 'impossible calendar day');
  assert.equal(parseOpenLibraryDate('circa 1965'), undefined);
  assert.equal(parseOpenLibraryDate(undefined), undefined);
});

test('normalizes an OpenLibrary search document into an edition candidate', () => {
  const candidate = candidateFromSearchDocument(searchDocument);
  assert.equal(candidate.title, 'The Left Hand of Darkness');
  assert.equal(candidate.subtitle, 'A Novel');
  assert.deepEqual(candidate.identifiers, [
    { issuer: 'openlibrary', value: 'OL123M' },
    { issuer: 'isbn13', value: ISBN13 },
    { issuer: 'isbn10', value: ISBN10 }
  ]);
  assert.equal(candidate.publishedDate, '1969');
  assert.equal(candidate.language, 'eng');
  assert.equal(candidate.pages, 304);
  assert.equal(candidate.coverUrl, 'https://covers.openlibrary.org/b/id/12345-L.jpg');
  assert.equal(candidate.publisher.name, 'Ace');
  assert.deepEqual(candidate.contributors, [
    {
      name: 'Ursula K. Le Guin',
      role: 'A01',
      identifiers: [{ issuer: 'openlibrary', value: AUTHOR_KEY }]
    }
  ]);
  assert.equal(candidateKey(candidate), `isbn:${ISBN13}`);
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
  assert.equal(searchCall.searchParams.get('q'), 'left hand le guin');
  assert.equal(searchCall.searchParams.get('limit'), String(SEARCH_LIMIT));
  assert.match(searchCall.searchParams.get('fields'), /edition_key/);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].title, 'The Left Hand of Darkness');
  assert.deepEqual(candidates[1].identifiers, [{ issuer: 'openlibrary', value: 'OL999W' }]);
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

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].description, 'Work description.');
  assert.equal(candidates[0].contributors[0].name, 'Ursula K. Le Guin');
  assert.equal(candidates[0].coverUrl, 'https://covers.openlibrary.org/b/id/12345-L.jpg');
  assert.equal(candidates[0].format, 'Paperback');
  assert.equal(candidates[0].series.name, 'The Hainish Cycle');
  assert.equal(candidates[0].language, 'eng');
  assert.deepEqual(
    candidates[0].identifiers,
    [
      { issuer: 'openlibrary', value: 'OL123M' },
      { issuer: 'isbn13', value: ISBN13 },
      { issuer: 'isbn10', value: ISBN10 }
    ]
  );
  assert.ok(calls.some((url) => url.pathname === `/isbn/${ISBN13}.json`));
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

  assert.equal(openLibraryBookKey('/books/OL123M'), 'OL123M');
  assert.equal(openLibraryBookKey('OL456W'), 'OL456W');
  assert.equal(openLibraryBookKey('/authors/OL789A'), undefined);

  const edition = await provider.byIdentifier('OL123M');
  assert.equal(edition.length, 1);
  assert.equal(edition[0].identifiers[0].value, 'OL123M');

  const work = await provider.byIdentifier('/works/OL456W');
  assert.equal(work.length, 2, 'the duplicate edition is merged');
  assert.deepEqual(
    work.map((candidate) => candidate.identifiers.find((id) => id.issuer === 'openlibrary').value),
    ['OL123M', 'OL124M']
  );
  assert.ok(calls.some((url) => url.pathname === '/works/OL456W/editions.json'));
});

test('byIsbn answers empty for a 404 and rejects a provider failure', async () => {
  const missing = openLibrary({ handler: () => jsonResponse({}, 404) });
  assert.deepEqual(await missing.provider.byIsbn(ISBN13), []);

  const broken = openLibrary({ handler: () => jsonResponse({ message: 'boom' }, 500) });
  await assert.rejects(() => broken.provider.byIsbn(ISBN13), /answered 500/);
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
  assert.equal(searchCall.searchParams.get('q'), 'le guin');
  assert.equal(searchCall.searchParams.get('limit'), '50', 'the provider caps the limit');
  assert.equal(contributors.length, 2);
  assert.deepEqual(contributors[0].identifiers, [{ issuer: 'openlibrary', value: AUTHOR_KEY }]);
  assert.equal(contributors[0].born, undefined, 'a bare year is omitted');
  assert.equal(contributors[1].born, undefined, 'a month/year is omitted');

  const detail = await provider.author(`/authors/${AUTHOR_KEY}`);
  assert.deepEqual(detail, {
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
  assert.equal(detail.role, undefined, 'contributor candidates never carry edition roles');
});

test('contributor normalization keeps partial dates out', () => {
  const contributor = contributorFromAuthorDocument({
    key: 'OL1A',
    name: 'No Full Dates',
    birth_date: '1900',
    death_date: '1970-06',
    remote_ids: {}
  });
  assert.equal(contributor.displayName, 'No Full Dates');
  assert.equal(contributor.born, undefined);
  assert.equal(contributor.died, undefined);
  assert.deepEqual(contributor.identifiers, [{ issuer: 'openlibrary', value: 'OL1A' }]);
  assert.equal(contributorFromAuthorDocument({ key: 'OL1A' }), undefined);
});

test('candidateFromEdition accepts missing optional fields', () => {
  const candidate = candidateFromEdition({
    key: '/books/OL1M',
    title: 'Minimal Edition',
    isbn_13: ['9780306406157']
  });
  assert.deepEqual(candidate, {
    title: 'Minimal Edition',
    identifiers: [
      { issuer: 'openlibrary', value: 'OL1M' },
      { issuer: 'isbn13', value: '9780306406157' }
    ],
    contributors: []
  });
  assert.equal(candidateFromEdition({ title: 'No identity' }), undefined);
});

test('provider chain tries OpenLibrary after Google and before Goodreads', async () => {
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
  assert.deepEqual(order, ['googlebooks', 'openlibrary']);
  assert.equal(candidates[0].title, 'The Left Hand of Darkness');
  assert.equal(providers.resilience.openlibrary.state, 'closed');
  assert.ok(
    providers.metrics
      .snapshot()
      .breaker.some((row) => row.provider === 'openlibrary' && row.state === 'closed')
  );
});

test('the ISBN chain tries OpenLibrary after Google and before Goodreads', async () => {
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
      order.push('goodreads');
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
  assert.deepEqual(order, ['googlebooks', 'openlibrary']);
  assert.equal(candidates[0].title, 'The Left Hand of Darkness');
});

test('a Google candidate still stops the chain before OpenLibrary', async () => {
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
  assert.deepEqual(candidates.map((candidate) => candidate.title), ['Google First']);
  assert.deepEqual(called, ['/google/volumes']);
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
  assert.equal(candidates[0].title, 'The Left Hand of Darkness');
  assert.ok(called.includes('/openlibrary/books/OL123M.json'));
  assert.ok(!called.some((path) => path.startsWith('/google/')));
  assert.ok(!called.some((path) => path.startsWith('/goodreads/')));
});
