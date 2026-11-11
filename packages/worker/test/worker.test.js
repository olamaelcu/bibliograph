import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

import { candidateFromVolume } from '../lib/providers/google-books.js';
import { candidateFromIsbndb } from '../lib/providers/isbndb.js';
import { candidatesFromBookPage, candidatesFromSearchPage } from '../lib/providers/goodreads.js';
import { createProviders } from '../lib/providers/index.js';
import { createTasks } from '../lib/tasks.js';
import { isbn10To13, stripHtml } from '../lib/util.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const PUBLISHER = 'test.example';

const googleBody = {
  totalItems: 1,
  items: [
    {
      id: 'efdyneVzATwC',
      volumeInfo: {
        title: 'The Left Hand of Darkness',
        authors: ['Ursula K. Le Guin'],
        publisher: 'Ace',
        publishedDate: '1969',
        language: 'en',
        pageCount: 304,
        description: '<p>A novel of the Ekumen.</p>',
        industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441478125' }],
        imageLinks: { thumbnail: 'http://books.example/cover.jpg' }
      }
    }
  ]
};

const plcBody = {
  totalItems: 1,
  items: [
    {
      id: 'plcAuthorityVolume',
      volumeInfo: {
        title: 'PLC Authority Edition',
        language: 'en',
        industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781111111111' }]
      }
    }
  ]
};

const isbndbBook = {
  title: 'Direct Hydration Volume',
  title_long: 'Direct Hydration Volume: A Test',
  authors: ['Isbn Test Author'],
  publisher: 'Isbn Direct Press',
  date_published: '2020',
  pages: 200,
  language: 'en',
  isbn13: '9780306406157',
  image: 'http://img.example/direct.jpg',
  synopsis: 'A direct ISBNdb lookup.'
};

const goodreadsSearchHtml = `<table><tr itemscope>
<td><a href="/book/show/18423"><img class="bookCover" itemprop="image" src="https://img.example/18423.jpg" /></a></td>
<td><a class="bookTitle" itemprop="url" href="/book/show/18423.The_Left_Hand"><span itemprop='name' role='heading'>The Left Hand of Darkness</span></a>
<span itemprop='author' itemscope='' itemtype='http://schema.org/Person'><div class='authorName__container'><a class="authorName" itemprop="url" href="/author/show/874602"><span itemprop="name">Ursula K. Le Guin</span></a></div></span></td>
</tr></table>`;

const goodreadsBookHtml = `<html><head></head><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      apolloState: {
        'Book:kca://book/1': {
          __typename: 'Book',
          legacyId: 118028,
          title: 'The Left Hand of Darkness',
          titleComplete: 'The Left Hand of Darkness',
          imageUrl: 'https://img.example/118028.jpg',
          description: '<i>See alternate editions</i> A novel.',
          details: {
            isbn13: '9780441478125',
            isbn: '0441478123',
            asin: 'B0073N8XKQ',
            numPages: 366,
            format: 'Paperback',
            publisher: 'Ace',
            publicationTime: 1291190400000,
            language: { name: 'English' }
          },
          primaryContributorEdge: { node: { __ref: 'Contributor:a' }, role: 'Author' },
          secondaryContributorEdges: [],
          bookSeries: [{ userPosition: '4', series: { __ref: 'Series:s' } }]
        },
        'Contributor:a': { __typename: 'Contributor', name: 'Ursula K. Le Guin' },
        'Series:s': { __typename: 'Series', title: 'The Hainish Cycle' }
      }
    }
  }
})}</script></body></html>`;

let server;
let baseUrl;
let isbndbRequests = 0;

async function cleanupHydrationRows(pool, host) {
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`at://did:web:${host}/%`]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`at://did:web:${host}/%`]);
  await pool.query("DELETE FROM contributors WHERE name IN ('Isbn Test Author', 'Ursula K. Le Guin')");
  await pool.query("DELETE FROM publishers WHERE name IN ('Isbn Direct Press', 'Ace')");
  await pool.query('DELETE FROM isbndb_cache WHERE key LIKE $1', [`${baseUrl}/isbndb/%`]);
  await pool.query('DELETE FROM google_books_cache WHERE key LIKE $1', [`${baseUrl}/%`]);
}

before(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (body, type = 'application/json') => {
      response.writeHead(200, { 'content-type': type });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/google/volumes') {
      const query = url.searchParams.get('q');
      if (query === 'isbn:9781111111111') send(plcBody);
      else send(query?.startsWith('isbn:') ? googleBody : { totalItems: 0, items: [] });
      return;
    }
    if (url.pathname === '/isbndb/book/9780306406157') {
      isbndbRequests += 1;
      send({ book: isbndbBook });
      return;
    }
    if (url.pathname.startsWith('/isbndb/')) {
      isbndbRequests += 1;
      send({ book: { title: 'Unused' } });
      return;
    }
    if (url.pathname.startsWith('/goodreads/search')) {
      send(goodreadsSearchHtml, 'text/html');
      return;
    }
    if (url.pathname.startsWith('/goodreads/book/show/')) {
      send(goodreadsBookHtml, 'text/html');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('normalizes ISBN-10 and strips HTML', () => {
  assert.equal(isbn10To13('0-441-47812-3'), '9780441478125');
  assert.equal(stripHtml('<p>Hello&nbsp;<b>world</b></p>'), 'Hello world');
});

test('parses a Google Books volume into an edition candidate', () => {
  const candidate = candidateFromVolume(googleBody.items[0]);
  assert.equal(candidate.title, 'The Left Hand of Darkness');
  assert.deepEqual(candidate.identifiers, [
    { issuer: 'googlebooks', value: 'efdyneVzATwC' },
    { issuer: 'isbn13', value: '9780441478125' }
  ]);
  assert.equal(candidate.publishedDate, '1969');
  assert.equal(candidate.coverUrl, 'https://books.example/cover.jpg');
  assert.equal(candidate.description, 'A novel of the Ekumen.');
});

test('parses ISBNdb, Goodreads search and Goodreads book pages', () => {
  const isbndb = candidateFromIsbndb({
    title: 'The Left Hand of Darkness',
    title_long: 'The Left Hand of Darkness: A Novel',
    authors: ['Ursula K. Le Guin'],
    publisher: 'Ace',
    date_published: '1969',
    pages: 304,
    language: 'en',
    isbn13: '9780441478125',
    image: 'http://img.example/isbndb.jpg',
    synopsis: 'A novel.'
  });
  assert.equal(isbndb.subtitle, 'A Novel');
  assert.equal(isbndb.coverUrl, 'https://img.example/isbndb.jpg');

  const fromSearch = candidatesFromSearchPage(goodreadsSearchHtml);
  assert.equal(fromSearch.length, 1);
  assert.deepEqual(fromSearch[0].identifiers, [{ issuer: 'goodreads', value: '18423' }]);
  assert.equal(fromSearch[0].contributors[0].name, 'Ursula K. Le Guin');

  const fromBook = candidatesFromBookPage(goodreadsBookHtml)[0];
  assert.equal(fromBook.title, 'The Left Hand of Darkness');
  assert.deepEqual(fromBook.identifiers, [
    { issuer: 'goodreads', value: '118028' },
    { issuer: 'isbn13', value: '9780441478125' },
    { issuer: 'asin', value: 'B0073N8XKQ' }
  ]);
  assert.equal(fromBook.pages, 366);
  assert.equal(fromBook.publisher.name, 'Ace');
  assert.equal(fromBook.series.name, 'The Hainish Cycle');
  assert.equal(fromBook.series.position, '4');
});

test('resolve hydrates the catalog from provider results', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const providers = createProviders({
    pool,
    env: {
      GOOGLE_BOOKS_BASE_URL: `${baseUrl}/google`,
      ISBNDB_BASE_URL: `${baseUrl}/isbndb`,
      GOODREADS_BASE_URL: `${baseUrl}/goodreads`
    }
  });
  const tasks = createTasks({ pool, providers, publisherHost: PUBLISHER });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await pool.query("DELETE FROM editions WHERE uri LIKE 'at://did:web:test.example/%'");
    await pool.query("DELETE FROM pds_outbox WHERE uri LIKE 'at://did:web:test.example/%'");
    await pool.query("DELETE FROM google_books_cache WHERE key LIKE $1", [`${baseUrl}/%`]);

    await tasks['catalog.resolve'](
      { identifier: { issuer: 'isbn13', value: '9780441478125' } },
      helpers
    );

    const edition = await pool.query(
      "SELECT uri, rkey, title, pages, cover_url FROM editions WHERE uri LIKE 'at://did:web:test.example/%'"
    );
    assert.equal(edition.rowCount, 1);
    assert.equal(edition.rows[0].rkey, 'gb.efdyneVzATwC');
    assert.equal(edition.rows[0].title, 'The Left Hand of Darkness');
    assert.equal(edition.rows[0].pages, 304);
    assert.equal(edition.rows[0].cover_url, 'https://books.example/cover.jpg');

    const identifiers = await pool.query(
      'SELECT issuer, value FROM edition_identifiers WHERE edition_uri = $1 ORDER BY issuer',
      [edition.rows[0].uri]
    );
    assert.deepEqual(identifiers.rows, [
      { issuer: 'googlebooks', value: 'efdyneVzATwC' },
      { issuer: 'isbn13', value: '9780441478125' }
    ]);

    const contributors = await pool.query(
      `SELECT c.name, ec.role FROM edition_contributors ec
       JOIN contributors c ON c.id = ec.contributor_id
       WHERE ec.edition_uri = $1`,
      [edition.rows[0].uri]
    );
    assert.deepEqual(contributors.rows, [{ name: 'Ursula K. Le Guin', role: 'author' }]);

    const outbox = await pool.query('SELECT collection, op FROM pds_outbox WHERE uri = $1', [
      edition.rows[0].uri
    ]);
    assert.deepEqual(outbox.rows, [
      { collection: 'community.lexicon.media.book.edition', op: 'create' }
    ]);

    // Idempotent: a second resolution updates in place, never duplicates.
    await tasks['catalog.resolve'](
      { identifier: { issuer: 'isbn13', value: '9780441478125' } },
      helpers
    );
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM editions WHERE uri LIKE 'at://did:web:test.example/%'"
    );
    assert.equal(count.rows[0].n, 1);
  } finally {
    await pool.query("DELETE FROM editions WHERE uri LIKE 'at://did:web:test.example/%'");
    await pool.query("DELETE FROM pds_outbox WHERE uri LIKE 'at://did:web:test.example/%'");
    await pool.query("DELETE FROM contributors WHERE name = 'Ursula K. Le Guin'");
    await pool.query("DELETE FROM publishers WHERE name = 'Ace'");
    await pool.query("DELETE FROM google_books_cache WHERE key LIKE $1", [`${baseUrl}/%`]);
    await pool.end();
  }
});

test('mints edition URIs under an explicit did:plc publisher authority', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const publisherDid = 'did:plc:testworkerauthority';
  const providers = createProviders({
    pool,
    env: {
      GOOGLE_BOOKS_BASE_URL: `${baseUrl}/google`,
      ISBNDB_BASE_URL: `${baseUrl}/isbndb`,
      GOODREADS_BASE_URL: `${baseUrl}/goodreads`
    }
  });
  const tasks = createTasks({ pool, providers, publisherDid, publisherHost: PUBLISHER });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };
  const prefix = `at://${publisherDid}/community.lexicon.media.book/`;

  try {
    await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`at://${publisherDid}/%`]);
    await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`at://${publisherDid}/%`]);

    await tasks['catalog.resolve'](
      { identifier: { issuer: 'isbn13', value: '9781111111111' } },
      helpers
    );

    const edition = await pool.query('SELECT uri, rkey, title FROM editions WHERE uri LIKE $1', [
      `at://${publisherDid}/%`
    ]);
    assert.equal(edition.rowCount, 1);
    assert.ok(edition.rows[0].uri.startsWith(prefix), edition.rows[0].uri);
    assert.equal(edition.rows[0].rkey, 'gb.plcAuthorityVolume');
    assert.equal(edition.rows[0].title, 'PLC Authority Edition');

    const outbox = await pool.query('SELECT collection, op FROM pds_outbox WHERE uri = $1', [
      edition.rows[0].uri
    ]);
    assert.deepEqual(outbox.rows, [
      { collection: 'community.lexicon.media.book.edition', op: 'create' }
    ]);
  } finally {
    await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`at://${publisherDid}/%`]);
    await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`at://${publisherDid}/%`]);
    await pool.query('DELETE FROM google_books_cache WHERE key LIKE $1', [`${baseUrl}/%`]);
    await pool.end();
  }
});

test('search falls back to Goodreads when Google finds nothing', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const providers = createProviders({
    pool,
    env: {
      GOOGLE_BOOKS_BASE_URL: `${baseUrl}/google`,
      ISBNDB_BASE_URL: `${baseUrl}/isbndb`,
      GOODREADS_BASE_URL: `${baseUrl}/goodreads`
    }
  });
  const tasks = createTasks({ pool, providers, publisherHost: PUBLISHER });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await pool.query("DELETE FROM editions WHERE uri LIKE 'at://did:web:test.example/%'");
    await pool.query("DELETE FROM pds_outbox WHERE uri LIKE 'at://did:web:test.example/%'");

    await tasks['catalog.search']({ title: 'Left Hand' }, helpers);

    const edition = await pool.query(
      "SELECT rkey, title, cover_url FROM editions WHERE uri LIKE 'at://did:web:test.example/%'"
    );
    assert.equal(edition.rowCount, 1);
    assert.equal(edition.rows[0].rkey, 'gr.18423');
    assert.equal(edition.rows[0].title, 'The Left Hand of Darkness');
    assert.equal(edition.rows[0].cover_url, 'https://img.example/18423.jpg');
  } finally {
    await pool.query("DELETE FROM editions WHERE uri LIKE 'at://did:web:test.example/%'");
    await pool.query("DELETE FROM pds_outbox WHERE uri LIKE 'at://did:web:test.example/%'");
    await pool.query("DELETE FROM contributors WHERE name = 'Ursula K. Le Guin'");
    await pool.query("DELETE FROM google_books_cache WHERE key LIKE $1", [`${baseUrl}/%`]);
    await pool.end();
  }
});

test('catalog.isbn hydrates directly from ISBNdb by ISBN', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const providers = createProviders({
    pool,
    env: {
      ISBNDB_API_KEY: 'test-key',
      ISBNDB_BASE_URL: `${baseUrl}/isbndb`,
      GOOGLE_BOOKS_BASE_URL: `${baseUrl}/google`,
      GOODREADS_BASE_URL: `${baseUrl}/goodreads`
    }
  });
  const tasks = createTasks({ pool, providers, publisherHost: 'isbn-direct.example' });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await cleanupHydrationRows(pool, 'isbn-direct.example');
    isbndbRequests = 0;

    await tasks['catalog.isbn']({ isbn: '9780306406157' }, helpers);

    const edition = await pool.query(
      "SELECT uri, rkey, title, pages, cover_url FROM editions WHERE uri LIKE 'at://did:web:isbn-direct.example/%'"
    );
    assert.equal(edition.rowCount, 1);
    assert.equal(edition.rows[0].rkey, 'isbn.9780306406157');
    assert.equal(edition.rows[0].title, 'Direct Hydration Volume');
    assert.equal(edition.rows[0].pages, 200);
    assert.equal(edition.rows[0].cover_url, 'https://img.example/direct.jpg');

    const identifiers = await pool.query(
      'SELECT issuer, value FROM edition_identifiers WHERE edition_uri = $1 ORDER BY issuer',
      [edition.rows[0].uri]
    );
    assert.deepEqual(identifiers.rows, [{ issuer: 'isbn13', value: '9780306406157' }]);

    const outbox = await pool.query('SELECT collection, op FROM pds_outbox WHERE uri = $1', [
      edition.rows[0].uri
    ]);
    assert.deepEqual(outbox.rows, [
      { collection: 'community.lexicon.media.book.edition', op: 'create' }
    ]);

    // A direct by-ISBN call, not the generic search path.
    assert.equal(isbndbRequests, 1);
  } finally {
    await cleanupHydrationRows(pool, 'isbn-direct.example');
    await pool.end();
  }
});

test('catalog.isbn falls back to the resolve chain without ISBNdb', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const providers = createProviders({
    pool,
    env: {
      GOOGLE_BOOKS_BASE_URL: `${baseUrl}/google`,
      ISBNDB_BASE_URL: `${baseUrl}/isbndb`,
      GOODREADS_BASE_URL: `${baseUrl}/goodreads`
    }
  });
  assert.equal(providers.providers.isbndb, null);
  const tasks = createTasks({ pool, providers, publisherHost: 'isbn-fallback.example' });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await cleanupHydrationRows(pool, 'isbn-fallback.example');
    isbndbRequests = 0;

    await tasks['catalog.isbn']({ isbn: '9780441478125' }, helpers);

    const edition = await pool.query(
      "SELECT rkey, title FROM editions WHERE uri LIKE 'at://did:web:isbn-fallback.example/%'"
    );
    assert.equal(edition.rowCount, 1);
    assert.equal(edition.rows[0].rkey, 'gb.efdyneVzATwC');
    assert.equal(edition.rows[0].title, 'The Left Hand of Darkness');

    // Without a key the fallback never reaches ISBNdb.
    assert.equal(isbndbRequests, 0);
  } finally {
    await cleanupHydrationRows(pool, 'isbn-fallback.example');
    await pool.end();
  }
});
