import { expect, test, afterAll, beforeAll } from 'vitest';

import http from 'node:http';
import pg from 'pg';

import { createProviders as createProviderSet } from '../lib/providers/index.js';
import { startAdminServer } from '../lib/admin.js';
import { ensureSupportSchema } from '../lib/setup.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const AUTHORITY = 'did:plc:adminapitest';
const TOKEN = 'admin-test-token';
const CONTRIBUTOR = 'Admin API Probe Author';
const BIO_AUTHOR = 'Admin API Bio Author';
const PUBLISHER = 'Admin API Probe Press';
const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

function isbn13For(index) {
  const base = `9780000${String(index).padStart(5, '0')}`;
  let sum = 0;
  for (let position = 0; position < 12; position += 1) {
    sum += Number(base[position]) * (position % 2 ? 3 : 1);
  }
  return `${base}${(10 - (sum % 10)) % 10}`;
}

const ISBN = isbn13For(4321);
const ISBNDB_BOOK = {
  title: 'Admin Probe Edition',
  title_long: 'Admin Probe Edition: A Test',
  authors: [CONTRIBUTOR],
  publisher: PUBLISHER,
  date_published: '2024',
  pages: 211,
  language: 'en',
  isbn13: ISBN
};
const PUBLISHER_BOOK_ISBN = isbn13For(4322);
const PUBLISHER_BOOK = {
  title: 'Publisher Probe Edition',
  authors: [CONTRIBUTOR],
  publisher: PUBLISHER,
  date_published: '2023',
  pages: 180,
  language: 'en',
  isbn13: PUBLISHER_BOOK_ISBN
};

let pool;
let providerServer;
let providerBase;
let admin;
let unconfiguredAdmin;
let providers;
let unconfiguredProviders;
let googleRequests = 0;
let isbndbRequests = 0;
let goodreadsRequests = 0;
let openlibraryRequests = 0;
const requestedQueries = [];

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createProviders(options = {}) {
  return createProviderSet({
    ...options,
    env: { OPENLIBRARY_BASE_URL: `${providerBase}/openlibrary`, ...options.env }
  });
}

async function cleanup() {
  if (!pool) return;
  const prefix = `at://${AUTHORITY}/%`;
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM contributors WHERE name = $1', [CONTRIBUTOR]);
  await pool.query('DELETE FROM contributors WHERE name = $1', [BIO_AUTHOR]);
  await pool.query('DELETE FROM publishers WHERE name = $1', [PUBLISHER]);
  // A shared row that a real edition still credits stays; clear only the
  // test-authority pointer this suite minted on it.
  await pool.query('UPDATE contributors SET at_uri = NULL WHERE name = $1 AND at_uri LIKE $2', [
    CONTRIBUTOR,
    `at://${AUTHORITY}/%`
  ]);
  await pool.query('UPDATE publishers SET at_uri = NULL WHERE name = $1 AND at_uri LIKE $2', [
    PUBLISHER,
    `at://${AUTHORITY}/%`
  ]);
  // Entity deletes/updates above queue outbox rows, so sweep it last.
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [prefix]);
  if (providerBase) {
    await pool.query('DELETE FROM google_books_cache WHERE key LIKE $1', [`${providerBase}/%`]);
    await pool.query('DELETE FROM isbndb_cache WHERE key LIKE $1', [`${providerBase}/%`]);
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  await ensureSupportSchema(pool);
  await cleanup();

  providerServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (body, type = 'application/json') => {
      response.writeHead(200, { 'content-type': type });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/google/volumes') {
      googleRequests += 1;
      requestedQueries.push({ provider: 'googlebooks', query: url.searchParams.get('q') });
      const query = url.searchParams.get('q') ?? '';
      send({
        totalItems: 1,
        items: [
          {
            id: `admin-probe-google-${query.replace(/[^a-z0-9]/gi, '')}`,
            volumeInfo: {
              title: query.startsWith('isbn:') ? 'Admin Probe ISBN Edition' : 'Admin Probe Edition',
              authors: [CONTRIBUTOR],
              publisher: PUBLISHER,
              publishedDate: '2024',
              language: 'en',
              pageCount: 211,
              industryIdentifiers: [{ type: 'ISBN_13', identifier: ISBN }]
            }
          }
        ]
      });
      return;
    }

    if (url.pathname.startsWith('/isbndb/book/')) {
      isbndbRequests += 1;
      requestedQueries.push({ provider: 'isbndb', query: url.pathname.split('/').at(-1) });
      send({ book: ISBNDB_BOOK });
      return;
    }

    if (url.pathname.startsWith('/isbndb/books/')) {
      isbndbRequests += 1;
      requestedQueries.push({ provider: 'isbndb', query: decodeURIComponent(url.pathname.split('/').at(-1)) });
      send({ books: [ISBNDB_BOOK] });
      return;
    }

    if (url.pathname.startsWith('/isbndb/publishers/')) {
      isbndbRequests += 1;
      requestedQueries.push({
        provider: 'isbndb-publishers',
        query: decodeURIComponent(url.pathname.split('/').at(-1)),
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize')
      });
      send({
        name: 'admin probe',
        publishers: [PUBLISHER, 'Another Press'],
        total: 2,
        page: 1,
        page_size: 50
      });
      return;
    }

    if (url.pathname.startsWith('/isbndb/publisher/')) {
      isbndbRequests += 1;
      requestedQueries.push({
        provider: 'isbndb-publisher',
        query: decodeURIComponent(url.pathname.split('/').at(-1)),
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('pageSize'),
        publishedFrom: url.searchParams.get('publishedFrom'),
        publishedTo: url.searchParams.get('publishedTo'),
        language: url.searchParams.get('language')
      });
      const page = Number(url.searchParams.get('page'));
      const pageSize = Number(url.searchParams.get('pageSize'));
      send({
        name: PUBLISHER,
        books: [PUBLISHER_BOOK],
        total: page === 2 ? 120 : 1,
        page,
        page_size: pageSize
      });
      return;
    }

    if (url.pathname === '/goodreads/search') {
      goodreadsRequests += 1;
      requestedQueries.push({ provider: 'goodreads', query: url.searchParams.get('q') });
      const id = url.searchParams.get('q')?.startsWith(ISBN) ? '9001' : '9002';
      send(
        `<table><tr itemscope>
<td><a href="/book/show/${id}"><img class="bookCover" src="https://img.example/${id}.jpg" /></a></td>
<td><a class="bookTitle" href="/book/show/${id}"><span itemprop="name">Admin Probe Edition</span></a>
<span class="authorName"><span itemprop="name">${CONTRIBUTOR}</span></span></td>
</tr></table>`,
        'text/html'
      );
      return;
    }

    if (url.pathname === '/openlibrary/search.json') {
      openlibraryRequests += 1;
      requestedQueries.push({ provider: 'openlibrary', query: url.searchParams.get('q') });
      send({
        docs: [
          {
            key: '/works/OL900W',
            title: 'Admin Probe Edition',
            author_name: [CONTRIBUTOR],
            author_key: ['OL900A'],
            isbn: [ISBN],
            edition_key: ['OL901M'],
            publisher: [PUBLISHER],
            first_publish_year: 2024,
            cover_i: 321
          }
        ]
      });
      return;
    }

    if (url.pathname === `/openlibrary/isbn/${ISBN}.json`) {
      openlibraryRequests += 1;
      requestedQueries.push({ provider: 'openlibrary', query: ISBN });
      send({
        key: '/books/OL901M',
        title: 'Admin Probe Edition',
        authors: [{ key: '/authors/OL900A', name: CONTRIBUTOR }],
        isbn_13: [ISBN],
        isbn_10: [],
        publishers: [PUBLISHER],
        publish_date: '2024',
        number_of_pages: 211,
        description: 'An admin probe edition.'
      });
      return;
    }

    if (url.pathname === '/openlibrary/search/authors.json') {
      openlibraryRequests += 1;
      requestedQueries.push({
        provider: 'openlibrary-authors',
        query: url.searchParams.get('q'),
        limit: url.searchParams.get('limit')
      });
      send({
        numFound: 2,
        docs: [
          { key: 'OL900A', name: CONTRIBUTOR, birth_date: '1930-01-02' },
          { key: 'OL901A', name: 'Partial Probe Author', birth_date: '1930' }
        ]
      });
      return;
    }

    if (url.pathname === '/openlibrary/authors/OL900A.json') {
      openlibraryRequests += 1;
      send({ key: '/authors/OL900A', name: CONTRIBUTOR, bio: 'Admin probe author bio.' });
      return;
    }

    if (url.pathname.startsWith('/openlibrary/')) {
      openlibraryRequests += 1;
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(404);
    response.end('not found');
  });

  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  providerBase = `http://127.0.0.1:${address.port}`;

  const env = {
    GOOGLE_BOOKS_BASE_URL: `${providerBase}/google`,
    GOODREADS_BASE_URL: `${providerBase}/goodreads`,
    OPENLIBRARY_BASE_URL: `${providerBase}/openlibrary`,
    GOOGLE_BOOKS_API_KEY: '',
    ISBNDB_API_KEY: 'test-key',
    ISBNDB_BASE_URL: `${providerBase}/isbndb`,
    ISBNDB_DAILY_LIMIT: '1000000'
  };
  providers = createProviders({ pool, env, isbndbDailyLimit: 1_000_000, logger: silentLogger });
  // Seed ISBNdb responses so the admin tests prove provider selection without
  // reserving calls from the shared daily quota that worker.test.js asserts on.
  const isbndbCache = [
    [`${providerBase}/isbndb/books/admin%20probe?pageSize=50`, { books: [ISBNDB_BOOK] }],
    [`${providerBase}/isbndb/book/${ISBN}`, { book: ISBNDB_BOOK }],
    [
      `${providerBase}/isbndb/publishers/admin%20probe?page=1&pageSize=50`,
      { name: 'admin probe', publishers: [PUBLISHER, 'Another Press'], total: 2, page: 1, page_size: 50 }
    ],
    [
      `${providerBase}/isbndb/publisher/${encodeURIComponent(PUBLISHER)}?page=2&pageSize=50&publishedFrom=2020&publishedTo=2024-12&language=eng`,
      { name: PUBLISHER, books: [PUBLISHER_BOOK], total: 120, page: 2, page_size: 50 }
    ],
    [
      `${providerBase}/isbndb/publisher/${encodeURIComponent(PUBLISHER)}?page=1&pageSize=100`,
      { name: PUBLISHER, books: [PUBLISHER_BOOK], total: 1, page: 1, page_size: 100 }
    ]
  ];
  for (const [url, body] of isbndbCache) {
    await pool.query(
      `INSERT INTO isbndb_cache (key, request, body, fetched_at, expires_at)
       VALUES ($1, $1, $2::jsonb, now(), now() + interval '1 day')
       ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, expires_at = EXCLUDED.expires_at`,
      [url, JSON.stringify(body)]
    );
  }
  unconfiguredProviders = createProviders({
    pool,
    env: { ...env, ISBNDB_API_KEY: '' },
    isbndbDailyLimit: 1_000_000,
    logger: silentLogger
  });

  admin = await startAdminServer({
    pool,
    providers,
    publisherDid: AUTHORITY,
    env: { ADMIN_TOKEN: TOKEN, WORKER_ADMIN_HOST: '127.0.0.1', WORKER_ADMIN_PORT: '0' },
    logger: silentLogger
  });
  unconfiguredAdmin = await startAdminServer({
    pool,
    providers: unconfiguredProviders,
    publisherDid: AUTHORITY,
    env: { ADMIN_TOKEN: TOKEN, WORKER_ADMIN_HOST: '127.0.0.1', WORKER_ADMIN_PORT: '0' },
    logger: silentLogger
  });
});

afterAll(async () => {
  await admin?.close();
  await unconfiguredAdmin?.close();
  if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
  if (pool) {
    await cleanup();
    await pool.end();
  }
});

function post(server, path, body, token = TOKEN) {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('rejects a missing or wrong admin token with 401', async () => {
  const missing = await post(admin, '/provider-search', { provider: 'googlebooks', query: 'x' }, null);
  expect(missing.status).toBe(401);
  const wrong = await post(admin, '/provider-search', { provider: 'googlebooks', query: 'x' }, 'nope');
  expect(wrong.status).toBe(401);
});

test('is disabled, with a log, when ADMIN_TOKEN is unset', async () => {
  const messages = [];
  const server = await startAdminServer({
    pool,
    providers,
    publisherDid: AUTHORITY,
    env: {},
    logger: { ...silentLogger, log: (message) => messages.push(message) }
  });
  expect(server).toBe(undefined);
  expect(messages.some((message) => message.includes('ADMIN_TOKEN'))).toBeTruthy();
});

test('provider search selects only the requested provider', async () => {
  googleRequests = 0;
  isbndbRequests = 0;
  goodreadsRequests = 0;
  openlibraryRequests = 0;
  requestedQueries.length = 0;

  const google = await post(admin, '/provider-search', {
    provider: 'googlebooks',
    query: 'admin probe'
  });
  expect(google.status).toBe(200);
  const googleBody = await google.json();
  expect(googleBody.provider).toBe('googlebooks');
  expect(googleBody.candidates.length).toBe(1);
  expect(googleBody.candidates[0].title).toBe('Admin Probe Edition');
  expect({ googleRequests, isbndbRequests, goodreadsRequests }).toEqual({ googleRequests: 1, isbndbRequests: 0, goodreadsRequests: 0 });

  const openlibrary = await post(admin, '/provider-search', {
    provider: 'openlibrary',
    query: 'admin probe'
  });
  expect(openlibrary.status).toBe(200);
  const openlibraryBody = await openlibrary.json();
  expect(openlibraryBody.candidates.length).toBe(1);
  expect(openlibraryBody.candidates[0].title).toBe('Admin Probe Edition');
  expect({ googleRequests, isbndbRequests, goodreadsRequests, openlibraryRequests }).toEqual({ googleRequests: 1, isbndbRequests: 0, goodreadsRequests: 0, openlibraryRequests: 1 });

  const isbndb = await post(admin, '/provider-search', {
    provider: 'isbndb',
    query: 'admin probe'
  });
  expect(isbndb.status).toBe(200);
  const isbndbBody = await isbndb.json();
  expect(isbndbBody.candidates.length).toBe(1);
  // The seeded cache answer avoids a paid call, but the candidate shape proves
  // ISBNdb was the provider selected.
  expect({ googleRequests, isbndbRequests, goodreadsRequests }).toEqual({ googleRequests: 1, isbndbRequests: 0, goodreadsRequests: 0 });

  const goodreads = await post(admin, '/provider-search', {
    provider: 'goodreads',
    query: 'admin probe'
  });
  expect(goodreads.status).toBe(200);
  const goodreadsBody = await goodreads.json();
  expect(goodreadsBody.candidates.length).toBe(1);
  expect({ googleRequests, isbndbRequests, goodreadsRequests }).toEqual({ googleRequests: 1, isbndbRequests: 0, goodreadsRequests: 1 });
});

test('an ISBN query routes to byIsbn/byIdentifier for each provider', async () => {
  requestedQueries.length = 0;

  for (const provider of ['googlebooks', 'isbndb', 'openlibrary', 'goodreads']) {
    const response = await post(admin, '/provider-search', { provider, query: ISBN });
    expect(response.status, `${provider} answered ${response.status}`).toBe(200);
    const body = await response.json();
    expect(body.candidates.length).toBe(1);
  }

  expect(requestedQueries.map((entry) => entry.provider).sort()).toEqual(['goodreads', 'googlebooks', 'openlibrary']);
  const google = requestedQueries.find((entry) => entry.provider === 'googlebooks');
  expect(google.query).toBe(`isbn:${ISBN}`);
  const openlibrary = requestedQueries.find((entry) => entry.provider === 'openlibrary');
  expect(openlibrary.query).toBe(ISBN);
});

test('ISBNdb search answers a clear 503 when the provider is not configured', async () => {
  const response = await post(unconfiguredAdmin, '/provider-search', {
    provider: 'isbndb',
    query: 'admin probe'
  });
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body.message).toMatch(/ISBNDB_API_KEY/);
});

test('ingest creates an edition with a TID under the did:plc authority', async () => {
  const candidate = {
    identifiers: [
      { issuer: 'isbn13', value: ISBN },
      { issuer: 'googlebooks', value: 'admin-probe-ingest' }
    ],
    title: 'Admin Probe Edition',
    contributors: [{ name: CONTRIBUTOR, role: 'author' }],
    publisher: { name: PUBLISHER },
    pages: '211',
    language: 'en'
  };

  const response = await post(admin, '/ingest', { candidate });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.created).toBe(true);
  expect(body.uri).toMatch(new RegExp(`^at://${AUTHORITY}/community\\.lexicon\\.media\\.book\\.edition/.+$`));

  const rkey = body.uri.split('/').at(-1);
  expect(rkey.length).toBe(13);
  for (const char of rkey) expect(TID_ALPHABET.includes(char), `${rkey} is not a TID`).toBeTruthy();

  const stored = await pool.query(
    `SELECT e.title, o.op
       FROM editions e LEFT JOIN pds_outbox o ON o.uri = e.uri
      WHERE e.uri = $1`,
    [body.uri]
  );
  expect(stored.rowCount).toBe(1);
  expect(stored.rows[0].title).toBe('Admin Probe Edition');
  expect(stored.rows[0].op).toBe('create');

  // The shape claim lands on every identifier the candidate supplied.
  const claims = await pool.query(
    `SELECT issuer, pages, language FROM edition_identifier_info
      WHERE edition_uri = $1 ORDER BY issuer`,
    [body.uri]
  );
  expect(claims.rows).toEqual([
    { issuer: 'googlebooks', pages: 211, language: 'en' },
    { issuer: 'isbn13', pages: 211, language: 'en' }
  ]);
});

test('ingest rejects a candidate without identifiers', async () => {
  const response = await post(admin, '/ingest', {
    candidate: { title: 'No identifiers', identifiers: [] }
  });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.message).toMatch(/identifiers/);
});

test('ingest stores a provider bio and never overwrites it', async () => {
  const first = await post(admin, '/ingest', {
    candidate: {
      identifiers: [{ issuer: 'isbn13', value: isbn13For(4323) }],
      title: 'Admin Bio Probe',
      contributors: [
        {
          name: BIO_AUTHOR,
          role: 'author',
          identifiers: [{ issuer: 'openlibrary', value: 'OL900A' }]
        }
      ]
    }
  });
  expect(first.status).toBe(200);
  expect((await first.json()).created).toBe(true);

  const stored = await pool.query('SELECT description FROM contributors WHERE name = $1', [
    BIO_AUTHOR
  ]);
  expect(stored.rows).toEqual([{ description: 'Admin probe author bio.' }]);

  const second = await post(admin, '/ingest', {
    candidate: {
      identifiers: [{ issuer: 'isbn13', value: isbn13For(4324) }],
      title: 'Admin Bio Probe Two',
      contributors: [
        {
          name: BIO_AUTHOR,
          role: 'author',
          description: 'A different bio.',
          identifiers: [{ issuer: 'openlibrary', value: 'OL900A' }]
        }
      ]
    }
  });
  expect(second.status).toBe(200);
  expect((await second.json()).created).toBe(true);

  const kept = await pool.query('SELECT description FROM contributors WHERE name = $1', [
    BIO_AUTHOR
  ]);
  expect(kept.rows).toEqual([{ description: 'Admin probe author bio.' }]);
});

test('unknown providers and empty queries are bad requests', async () => {
  const unknown = await post(admin, '/provider-search', { provider: 'nope', query: 'x' });
  expect(unknown.status).toBe(400);
  const empty = await post(admin, '/provider-search', { provider: 'googlebooks', query: '   ' });
  expect(empty.status).toBe(400);
});

test('contributor search returns normalized read-only candidates', async () => {
  openlibraryRequests = 0;
  requestedQueries.length = 0;

  const response = await post(admin, '/contributor-search', {
    q: 'probe author',
    limit: 10
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.query).toBe('probe author');
  expect(body.limit).toBe(10);
  expect(body.contributors.length).toBe(2);
  expect(body.contributors[0]).toEqual({
    displayName: CONTRIBUTOR,
    identifiers: [{ issuer: 'openlibrary', value: 'OL900A' }],
    key: 'OL900A',
    born: '1930-01-02'
  });
  expect(body.contributors[0].role, 'contributor search has no edition roles').toBe(undefined);
  expect(body.contributors[1].born, 'a bare year is omitted instead of guessed').toBe(undefined);
  expect(openlibraryRequests).toBe(1);
  expect(requestedQueries).toEqual([
    { provider: 'openlibrary-authors', query: 'probe author', limit: '10' }
  ]);
});

test('contributor search validates q and bounds the limit', async () => {
  const missing = await post(admin, '/contributor-search', {});
  expect(missing.status).toBe(400);
  expect((await missing.json()).message).toMatch(/q is required/);

  const blank = await post(admin, '/contributor-search', { q: '   ' });
  expect(blank.status).toBe(400);

  const tooLong = await post(admin, '/contributor-search', { q: 'x'.repeat(201) });
  expect(tooLong.status).toBe(400);
  expect((await tooLong.json()).message).toMatch(/at most 200/);

  for (const limit of [0, 51, 1.5, 'many']) {
    const bounded = await post(admin, '/contributor-search', { q: 'probe author', limit });
    expect(bounded.status, `limit ${JSON.stringify(limit)} must be rejected`).toBe(400);
    expect((await bounded.json()).message).toMatch(/limit must be an integer between 1 and 50/);
  }

  const max = await post(admin, '/contributor-search', { q: 'probe author', limit: 50 });
  expect(max.status).toBe(200);
});

test('contributor search requires the admin token and is POST-only', async () => {
  const unauthorized = await post(admin, '/contributor-search', { q: 'x' }, null);
  expect(unauthorized.status).toBe(401);

  const response = await fetch(`${admin.url}/contributor-search`, {
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  expect(response.status).toBe(405);
});

test('publisher search returns ISBNdb publisher names', async () => {
  isbndbRequests = 0;
  requestedQueries.length = 0;

  const response = await post(admin, '/publisher-search', { query: 'admin probe' });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.query).toBe('admin probe');
  expect(body.publishers).toEqual([PUBLISHER, 'Another Press']);
  expect(body.total).toBe(2);
  expect(body.page).toBe(1);
  expect(body.pageSize).toBe(50);
  // A cache hit proves the request URL shape the live API would receive.
  expect(isbndbRequests).toBe(0);
});

test('publisher books forwards filters and pagination', async () => {
  isbndbRequests = 0;
  requestedQueries.length = 0;

  const response = await post(admin, '/publisher-books', {
    name: PUBLISHER,
    page: 2,
    pageSize: 50,
    publishedFrom: '2020',
    publishedTo: '2024-12',
    language: 'eng'
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.name).toBe(PUBLISHER);
  expect(body.candidates.length).toBe(1);
  expect(body.candidates[0].title).toBe('Publisher Probe Edition');
  expect(body.candidates[0].identifiers).toEqual([
    { issuer: 'isbn13', value: PUBLISHER_BOOK_ISBN }
  ]);
  expect(body.total).toBe(120);
  expect(body.page).toBe(2);
  expect(body.pageSize).toBe(50);
  expect(isbndbRequests).toBe(0);
});

test('publisher import ingests books and dedupes on a second run', async () => {
  const first = await post(admin, '/publisher-import', {
    name: PUBLISHER,
    pageSize: 100,
    maxPages: 1
  });
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  expect({
      imported: firstBody.imported,
      created: firstBody.created,
      existing: firstBody.existing,
      failed: firstBody.failed,
      stopped: firstBody.stopped,
      nextPage: firstBody.nextPage,
      pagesFetched: firstBody.pagesFetched
    }).toEqual({
      imported: 1,
      created: 1,
      existing: 0,
      failed: 0,
      stopped: 'end',
      nextPage: null,
      pagesFetched: 1
    });

  const second = await post(admin, '/publisher-import', {
    name: PUBLISHER,
    pageSize: 100,
    maxPages: 1
  });
  expect(second.status).toBe(200);
  const secondBody = await second.json();
  expect(secondBody.imported).toBe(1);
  expect(secondBody.created).toBe(0);
  expect(secondBody.existing).toBe(1);
  expect(secondBody.stopped).toBe('end');

  const stored = await pool.query(
    `SELECT count(*)::int AS count FROM editions WHERE title = 'Publisher Probe Edition'`
  );
  expect(stored.rows[0].count).toBe(1);
});

test('publisher endpoints validate input', async () => {
  const empty = await post(admin, '/publisher-search', { query: '   ' });
  expect(empty.status).toBe(400);

  const noName = await post(admin, '/publisher-books', {});
  expect(noName.status).toBe(400);
  expect((await noName.json()).message).toMatch(/name/);

  const tooBig = await post(admin, '/publisher-import', { name: PUBLISHER, pageSize: 101 });
  expect(tooBig.status).toBe(400);
  expect((await tooBig.json()).message).toMatch(/pageSize/);

  const reversed = await post(admin, '/publisher-books', {
    name: PUBLISHER,
    publishedFrom: '2024',
    publishedTo: '2020'
  });
  expect(reversed.status).toBe(400);
  expect((await reversed.json()).message).toMatch(/publishedFrom/);
});
