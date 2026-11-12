import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

import { createProviders } from '../lib/providers/index.js';
import { startAdminServer } from '../lib/admin.js';
import { ensureSupportSchema } from '../lib/setup.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const AUTHORITY = 'did:plc:adminapitest';
const TOKEN = 'admin-test-token';
const CONTRIBUTOR = 'Admin API Probe Author';
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
const requestedQueries = [];

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

async function cleanup() {
  if (!pool) return;
  const prefix = `at://${AUTHORITY}/%`;
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [prefix]);
  await pool.query('DELETE FROM contributors WHERE name = $1', [CONTRIBUTOR]);
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

before(async () => {
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

    response.writeHead(404);
    response.end('not found');
  });

  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  providerBase = `http://127.0.0.1:${address.port}`;

  const env = {
    GOOGLE_BOOKS_BASE_URL: `${providerBase}/google`,
    GOODREADS_BASE_URL: `${providerBase}/goodreads`,
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

after(async () => {
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
  assert.equal(missing.status, 401);
  const wrong = await post(admin, '/provider-search', { provider: 'googlebooks', query: 'x' }, 'nope');
  assert.equal(wrong.status, 401);
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
  assert.equal(server, undefined);
  assert.ok(messages.some((message) => message.includes('ADMIN_TOKEN')));
});

test('provider search selects only the requested provider', async () => {
  googleRequests = 0;
  isbndbRequests = 0;
  goodreadsRequests = 0;
  requestedQueries.length = 0;

  const google = await post(admin, '/provider-search', {
    provider: 'googlebooks',
    query: 'admin probe'
  });
  assert.equal(google.status, 200);
  const googleBody = await google.json();
  assert.equal(googleBody.provider, 'googlebooks');
  assert.equal(googleBody.candidates.length, 1);
  assert.equal(googleBody.candidates[0].title, 'Admin Probe Edition');
  assert.deepEqual(
    { googleRequests, isbndbRequests, goodreadsRequests },
    { googleRequests: 1, isbndbRequests: 0, goodreadsRequests: 0 }
  );

  const isbndb = await post(admin, '/provider-search', {
    provider: 'isbndb',
    query: 'admin probe'
  });
  assert.equal(isbndb.status, 200);
  const isbndbBody = await isbndb.json();
  assert.equal(isbndbBody.candidates.length, 1);
  // The seeded cache answer avoids a paid call, but the candidate shape proves
  // ISBNdb was the provider selected.
  assert.deepEqual(
    { googleRequests, isbndbRequests, goodreadsRequests },
    { googleRequests: 1, isbndbRequests: 0, goodreadsRequests: 0 }
  );

  const goodreads = await post(admin, '/provider-search', {
    provider: 'goodreads',
    query: 'admin probe'
  });
  assert.equal(goodreads.status, 200);
  const goodreadsBody = await goodreads.json();
  assert.equal(goodreadsBody.candidates.length, 1);
  assert.deepEqual(
    { googleRequests, isbndbRequests, goodreadsRequests },
    { googleRequests: 1, isbndbRequests: 0, goodreadsRequests: 1 }
  );
});

test('an ISBN query routes to byIsbn/byIdentifier for each provider', async () => {
  requestedQueries.length = 0;

  for (const provider of ['googlebooks', 'isbndb', 'goodreads']) {
    const response = await post(admin, '/provider-search', { provider, query: ISBN });
    assert.equal(response.status, 200, `${provider} answered ${response.status}`);
    const body = await response.json();
    assert.equal(body.candidates.length, 1);
  }

  assert.deepEqual(
    requestedQueries.map((entry) => entry.provider).sort(),
    ['goodreads', 'googlebooks']
  );
  const google = requestedQueries.find((entry) => entry.provider === 'googlebooks');
  assert.equal(google.query, `isbn:${ISBN}`);
});

test('ISBNdb search answers a clear 503 when the provider is not configured', async () => {
  const response = await post(unconfiguredAdmin, '/provider-search', {
    provider: 'isbndb',
    query: 'admin probe'
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.message, /ISBNDB_API_KEY/);
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
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.created, true);
  assert.match(body.uri, new RegExp(`^at://${AUTHORITY}/community\\.lexicon\\.media\\.book\\.edition/.+$`));

  const rkey = body.uri.split('/').at(-1);
  assert.equal(rkey.length, 13);
  for (const char of rkey) assert.ok(TID_ALPHABET.includes(char), `${rkey} is not a TID`);

  const stored = await pool.query(
    `SELECT e.title, e.pages, e.language, o.op
       FROM editions e LEFT JOIN pds_outbox o ON o.uri = e.uri
      WHERE e.uri = $1`,
    [body.uri]
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].title, 'Admin Probe Edition');
  assert.equal(stored.rows[0].pages, 211);
  assert.equal(stored.rows[0].language, 'en');
  assert.equal(stored.rows[0].op, 'create');
});

test('ingest rejects a candidate without identifiers', async () => {
  const response = await post(admin, '/ingest', {
    candidate: { title: 'No identifiers', identifiers: [] }
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.message, /identifiers/);
});

test('unknown providers and empty queries are bad requests', async () => {
  const unknown = await post(admin, '/provider-search', { provider: 'openlibrary', query: 'x' });
  assert.equal(unknown.status, 400);
  const empty = await post(admin, '/provider-search', { provider: 'googlebooks', query: '   ' });
  assert.equal(empty.status, 400);
});

test('publisher search returns ISBNdb publisher names', async () => {
  isbndbRequests = 0;
  requestedQueries.length = 0;

  const response = await post(admin, '/publisher-search', { query: 'admin probe' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.query, 'admin probe');
  assert.deepEqual(body.publishers, [PUBLISHER, 'Another Press']);
  assert.equal(body.total, 2);
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 50);
  // A cache hit proves the request URL shape the live API would receive.
  assert.equal(isbndbRequests, 0);
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
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.name, PUBLISHER);
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].title, 'Publisher Probe Edition');
  assert.deepEqual(body.candidates[0].identifiers, [
    { issuer: 'isbn13', value: PUBLISHER_BOOK_ISBN }
  ]);
  assert.equal(body.total, 120);
  assert.equal(body.page, 2);
  assert.equal(body.pageSize, 50);
  assert.equal(isbndbRequests, 0);
});

test('publisher import ingests books and dedupes on a second run', async () => {
  const first = await post(admin, '/publisher-import', {
    name: PUBLISHER,
    pageSize: 100,
    maxPages: 1
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(
    {
      imported: firstBody.imported,
      created: firstBody.created,
      existing: firstBody.existing,
      failed: firstBody.failed,
      stopped: firstBody.stopped,
      nextPage: firstBody.nextPage,
      pagesFetched: firstBody.pagesFetched
    },
    {
      imported: 1,
      created: 1,
      existing: 0,
      failed: 0,
      stopped: 'end',
      nextPage: null,
      pagesFetched: 1
    }
  );

  const second = await post(admin, '/publisher-import', {
    name: PUBLISHER,
    pageSize: 100,
    maxPages: 1
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.imported, 1);
  assert.equal(secondBody.created, 0);
  assert.equal(secondBody.existing, 1);
  assert.equal(secondBody.stopped, 'end');

  const stored = await pool.query(
    `SELECT count(*)::int AS count FROM editions WHERE title = 'Publisher Probe Edition'`
  );
  assert.equal(stored.rows[0].count, 1);
});

test('publisher endpoints validate input', async () => {
  const empty = await post(admin, '/publisher-search', { query: '   ' });
  assert.equal(empty.status, 400);

  const noName = await post(admin, '/publisher-books', {});
  assert.equal(noName.status, 400);
  assert.match((await noName.json()).message, /name/);

  const tooBig = await post(admin, '/publisher-import', { name: PUBLISHER, pageSize: 101 });
  assert.equal(tooBig.status, 400);
  assert.match((await tooBig.json()).message, /pageSize/);

  const reversed = await post(admin, '/publisher-books', {
    name: PUBLISHER,
    publishedFrom: '2024',
    publishedTo: '2020'
  });
  assert.equal(reversed.status, 400);
  assert.match((await reversed.json()).message, /publishedFrom/);
});
