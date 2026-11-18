import { expect, test, beforeAll, afterAll } from 'vitest';

import http from 'node:http';
import pg from 'pg';

import { candidateFromVolume } from '../lib/providers/google-books.js';
import { candidateFromIsbndb, cleanIsbndbSynopsis } from '../lib/providers/isbndb.js';
import { candidatesFromBookPage, candidatesFromSearchPage } from '../lib/providers/goodreads.js';
import { createProviders as createProviderSet } from '../lib/providers/index.js';
import { createTasks } from '../lib/tasks.js';
import { isbn10To13, stripHtml } from '../lib/util.js';
import { ensureSupportSchema } from '../lib/setup.js';
import { createMetricsServer } from '../lib/metrics.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const PUBLISHER = 'test.example';

// Fixture identifiers must never name a real edition. This suite runs against
// the development catalog, which already owns every real ISBN, Google volume
// id, Goodreads id and ASIN these fixtures used to carry; hydration resolves an
// identifier bag to the edition that owns it, so a real identifier makes the
// test update that edition instead of minting one under the test authority
// (and the assertion then finds no row). `isbn13For` builds checksum-valid,
// unassigned ISBNs; the volume, Goodreads and ASIN values are unassigned too.
const GOOGLE_VOLUME_ID = 'testworkerVolume1';
const GOOGLE_ISBN = isbn13For(100);
const PLC_ISBN = isbn13For(101);
const GOODREADS_BOOK_ID = '990001';
const GOODREADS_ISBN = isbn13For(102);
const GOODREADS_ASIN = 'B00TESTWRK';
const ISBNDB_ISBN = isbn13For(103);

const googleBody = {
  totalItems: 1,
  items: [
    {
      id: GOOGLE_VOLUME_ID,
      volumeInfo: {
        title: 'The Left Hand of Darkness',
        authors: ['Ursula K. Le Guin'],
        publisher: 'Ace',
        publishedDate: '1969',
        language: 'en',
        pageCount: 304,
        description: '<p>A novel of the Ekumen.</p>',
        industryIdentifiers: [{ type: 'ISBN_13', identifier: GOOGLE_ISBN }],
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
        industryIdentifiers: [{ type: 'ISBN_13', identifier: PLC_ISBN }]
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
  isbn13: ISBNDB_ISBN,
  image: 'http://img.example/direct.jpg',
  synopsis: 'A direct ISBNdb lookup.'
};

const goodreadsSearchHtml = `<table><tr itemscope>
<td><a href="/book/show/${GOODREADS_BOOK_ID}"><img class="bookCover" itemprop="image" src="https://img.example/${GOODREADS_BOOK_ID}.jpg" /></a></td>
<td><a class="bookTitle" itemprop="url" href="/book/show/${GOODREADS_BOOK_ID}.The_Left_Hand"><span itemprop='name' role='heading'>The Left Hand of Darkness</span></a>
<span itemprop='author' itemscope='' itemtype='http://schema.org/Person'><div class='authorName__container'><a class="authorName" itemprop="url" href="/author/show/874602"><span itemprop="name">Ursula K. Le Guin</span></a></div></span></td>
</tr></table>`;

const goodreadsBookHtml = `<html><head></head><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      apolloState: {
        'Book:kca://book/1': {
          __typename: 'Book',
          legacyId: Number(GOODREADS_BOOK_ID),
          title: 'The Left Hand of Darkness',
          titleComplete: 'The Left Hand of Darkness',
          imageUrl: `https://img.example/${GOODREADS_BOOK_ID}.jpg`,
          description: '<i>See alternate editions</i> A novel.',
          details: {
            isbn13: GOODREADS_ISBN,
            asin: GOODREADS_ASIN,
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

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

function assertTid(rkey) {
  expect(typeof rkey).toBe('string');
  expect(rkey.length, `${rkey} is not a 13-char TID`).toBe(13);
  for (const char of rkey) {
    expect(TID_ALPHABET.includes(char), `${rkey} has a non-base32-sortable character`).toBeTruthy();
  }
}

/** Build a checksum-valid ISBN-13 so `candidateFromIsbndb` accepts it. */
function isbn13For(index) {
  const base = `97800000${String(index).padStart(4, '0')}`;
  let sum = 0;
  for (let position = 0; position < 12; position += 1) {
    sum += Number(base[position]) * (position % 2 ? 3 : 1);
  }
  return `${base}${(10 - (sum % 10)) % 10}`;
}

const isbndbOrderBook = {
  title: 'ISBNdb First Volume',
  authors: ['Isbn Order Author'],
  publisher: 'Isbn Order Press',
  isbn13: isbn13For(900)
};

const CAP_BOOKS = Array.from({ length: 60 }, (_, index) => ({
  title: `Cap Volume ${index}`,
  isbn13: isbn13For(index)
}));

let googleRequests = 0;
let goodreadsRequests = 0;
let openlibraryRequests = 0;
const providerOrder = [];
const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

// Every test set points OpenLibrary at the local stub. Without this a fallback
// test that reaches the new provider would call the real public API.
function createProviders(options = {}) {
  return createProviderSet({
    ...options,
    env: { OPENLIBRARY_BASE_URL: `${baseUrl}/openlibrary`, ...options.env }
  });
}

/**
 * Put shared rows back the way the tests found them. A test ingest mints an
 * `at_uri` for a contributor/publisher that may already exist in the populated
 * development catalog; deleting that row would violate the edition FK, so the
 * row stays and only the test-authority pointer is cleared.
 */
async function releaseTestEntityUris(pool, authority) {
  const prefix = `at://${authority}/%`;
  await pool.query(
    `UPDATE contributors SET at_uri = NULL
      WHERE at_uri LIKE $1
        AND name IN ('Isbn Test Author', 'Ursula K. Le Guin', 'Isbn Order Author')`,
    [prefix]
  );
  await pool.query(
    `UPDATE publishers SET at_uri = NULL
      WHERE at_uri LIKE $1
        AND name IN ('Isbn Direct Press', 'Ace', 'Isbn Order Press')`,
    [prefix]
  );
}

async function cleanupHydrationRows(pool, host) {
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`at://did:web:${host}/%`]);
  await pool.query(
    `DELETE FROM contributors c
      WHERE c.name IN ('Isbn Test Author', 'Ursula K. Le Guin', 'Isbn Order Author')
        AND NOT EXISTS (
          SELECT 1 FROM edition_contributors ec WHERE ec.contributor_id = c.id
        )`
  );
  await pool.query(
    `DELETE FROM publishers p
      WHERE p.name IN ('Isbn Direct Press', 'Ace', 'Isbn Order Press')
        AND NOT EXISTS (
          SELECT 1 FROM edition_identifier_publishers ep WHERE ep.publisher_id = p.id
        )`
  );
  await releaseTestEntityUris(pool, `did:web:${host}`);
  // Last: deleting an entity with an at_uri queues its outbox delete, so the
  // row cleanup above must finish before the outbox is swept.
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`at://did:web:${host}/%`]);
  await pool.query('DELETE FROM isbndb_cache WHERE key LIKE $1', [`${baseUrl}/isbndb/%`]);
  await pool.query('DELETE FROM google_books_cache WHERE key LIKE $1', [`${baseUrl}/%`]);
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (body, type = 'application/json') => {
      response.writeHead(200, { 'content-type': type });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/google/volumes') {
      googleRequests += 1;
      providerOrder.push('googlebooks');
      const query = url.searchParams.get('q');
      if (query === `isbn:${PLC_ISBN}`) send(plcBody);
      else if (query === 'google-fills') send(googleBody);
      else send(query?.startsWith('isbn:') ? googleBody : { totalItems: 0, items: [] });
      return;
    }
    if (url.pathname === `/isbndb/book/${ISBNDB_ISBN}`) {
      isbndbRequests += 1;
      send({ book: isbndbBook });
      return;
    }
    if (url.pathname === `/isbndb/book/${GOOGLE_ISBN}`) {
      // A configured ISBNdb that has no record for the ISBN.
      isbndbRequests += 1;
      send({ book: null });
      return;
    }
    if (url.pathname === '/isbndb/books/isbndb-first') {
      isbndbRequests += 1;
      send({ books: [isbndbOrderBook] });
      return;
    }
    if (url.pathname === '/isbndb/books/cap-test') {
      isbndbRequests += 1;
      send({ books: CAP_BOOKS });
      return;
    }
    if (url.pathname.startsWith('/isbndb/')) {
      isbndbRequests += 1;
      send({ books: [] });
      return;
    }
    if (url.pathname.startsWith('/goodreads/search')) {
      goodreadsRequests += 1;
      providerOrder.push('goodreads');
      send(
        url.searchParams.get('q') === 'openlibrary-fills'
          ? '<table></table>'
          : goodreadsSearchHtml,
        'text/html'
      );
      return;
    }
    if (url.pathname.startsWith('/goodreads/book/show/')) {
      goodreadsRequests += 1;
      send(goodreadsBookHtml, 'text/html');
      return;
    }
    if (url.pathname === '/openlibrary/search.json') {
      openlibraryRequests += 1;
      providerOrder.push('openlibrary');
      const query = url.searchParams.get('q');
      if (query === 'openlibrary-fills') {
        send({
          docs: [
            {
              key: '/works/OL990W',
              title: 'OpenLibrary Fallback Volume',
              author_name: ['Isbn Order Author'],
              author_key: ['OL991A'],
              isbn: [isbn13For(950)],
              edition_key: ['OL992M'],
              first_publish_year: 2020
            }
          ]
        });
      } else {
        send({ docs: [] });
      }
      return;
    }
    if (url.pathname.startsWith('/openlibrary/')) {
      openlibraryRequests += 1;
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The ISBNdb provider reserves calls in provider_daily_usage, which the
  // worker creates at boot. Tests exercise that same boot path.
  const schemaPool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    await ensureSupportSchema(schemaPool);
  } finally {
    await schemaPool.end();
  }
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('normalizes ISBN-10 and strips HTML', () => {
  expect(isbn10To13('0-441-47812-3')).toBe('9780441478125');
  expect(stripHtml('<p>Hello&nbsp;<b>world</b></p>')).toBe('Hello world');
});

test('unwraps ISBNdb synopsis citations without touching other descriptions', () => {
  expect(cleanIsbndbSynopsis('"Walter Rodney was assassinated."--Back cover.')).toBe('Walter Rodney was assassinated.');
  expect(cleanIsbndbSynopsis('"In his short life he set a movement in motion."--Provided by publisher.')).toBe('In his short life he set a movement in motion.');
  expect(cleanIsbndbSynopsis('“The best book of the year.”—Kirkus Reviews')).toBe('The best book of the year.');
  expect(cleanIsbndbSynopsis('"A novel."')).toBe('A novel.');
  expect(cleanIsbndbSynopsis('<p>&quot;A novel.&quot;--Back cover.</p>')).toBe('A novel.');

  expect(cleanIsbndbSynopsis('"A "strange" novel."--Back cover.')).toBe('A "strange" novel.');

  const unquoted = 'A novel described as "strange".';
  expect(cleanIsbndbSynopsis(unquoted)).toBe(unquoted);
  const unquotedAttribution = 'A novel. --Back cover.';
  expect(cleanIsbndbSynopsis(unquotedAttribution)).toBe(unquotedAttribution);
  const apostrophes = 'The dog\'s "best" friend.';
  expect(cleanIsbndbSynopsis(apostrophes)).toBe(apostrophes);
  const notWholeValue = '"A novel." and more.';
  expect(cleanIsbndbSynopsis(notWholeValue)).toBe(notWholeValue);
  const multiCitation =
    '"A seminal text in the womenís movement." –Ethel S. Person, author of The Sexual Century ' +
    '"Still the most important work of feminist psychoanalytic exploration." –Eli Sagan, ' +
    'author of Freud, Women and Mortality';
  expect(cleanIsbndbSynopsis(multiCitation)).toBe(multiCitation);
  const adjacentCitations = '"First review." "Second review continues."--Jacket.';
  expect(cleanIsbndbSynopsis(adjacentCitations)).toBe(adjacentCitations);
  const blurbWithSynopsis =
    '"A magical revolution on the page." -- Leigh Bardugo, author of Six of Crows ' +
    'Shadowhouse rising begins a new story.';
  expect(cleanIsbndbSynopsis(blurbWithSynopsis)).toBe(blurbWithSynopsis);
  expect(cleanIsbndbSynopsis(undefined)).toBe(undefined);

  const candidate = candidateFromIsbndb({
    title: 'Quoted Synopsis',
    isbn13: '9780306406157',
    synopsis: '"The actual body."--Kirkus Reviews'
  });
  expect(candidate.description).toBe('The actual body.');
});

test('parses a Google Books volume into an edition candidate', () => {
  const candidate = candidateFromVolume(googleBody.items[0]);
  expect(candidate.title).toBe('The Left Hand of Darkness');
  expect(candidate.identifiers).toEqual([
    { issuer: 'googlebooks', value: GOOGLE_VOLUME_ID },
    { issuer: 'isbn13', value: GOOGLE_ISBN }
  ]);
  expect(candidate.publishedDate).toBe('1969');
  expect(candidate.coverUrl).toBe('https://books.example/cover.jpg');
  expect(candidate.description).toBe('A novel of the Ekumen.');
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
    isbn13: ISBNDB_ISBN,
    image: 'http://img.example/isbndb.jpg',
    synopsis: 'A novel.'
  });
  expect(isbndb.subtitle).toBe('A Novel');
  expect(isbndb.coverUrl).toBe('https://img.example/isbndb.jpg');

  const fromSearch = candidatesFromSearchPage(goodreadsSearchHtml);
  expect(fromSearch.length).toBe(1);
  expect(fromSearch[0].identifiers).toEqual([{ issuer: 'goodreads', value: GOODREADS_BOOK_ID }]);
  expect(fromSearch[0].contributors[0].name).toBe('Ursula K. Le Guin');

  const fromBook = candidatesFromBookPage(goodreadsBookHtml)[0];
  expect(fromBook.title).toBe('The Left Hand of Darkness');
  expect(fromBook.identifiers).toEqual([
    { issuer: 'goodreads', value: GOODREADS_BOOK_ID },
    { issuer: 'isbn13', value: GOODREADS_ISBN },
    { issuer: 'asin', value: GOODREADS_ASIN }
  ]);
  expect(fromBook.pages).toBe(366);
  expect(fromBook.publisher.name).toBe('Ace');
  expect(fromBook.series.name).toBe('The Hainish Cycle');
  expect(fromBook.series.position).toBe('4');
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
      { identifier: { issuer: 'isbn13', value: GOOGLE_ISBN } },
      helpers
    );

    const edition = await pool.query(
      "SELECT uri, rkey, title, cover_url FROM editions WHERE uri LIKE 'at://did:web:test.example/%'"
    );
    expect(edition.rowCount).toBe(1);
    assertTid(edition.rows[0].rkey);
    expect(edition.rows[0].uri).toBe(`at://did:web:test.example/community.lexicon.media.book.edition/${edition.rows[0].rkey}`);
    expect(edition.rows[0].title).toBe('The Left Hand of Darkness');
    expect(edition.rows[0].cover_url).toBe('https://books.example/cover.jpg');

    // The shape claim belongs to the identifier (0007), not the edition row.
    const claims = await pool.query(
      `SELECT issuer, pages, language FROM edition_identifier_info
        WHERE edition_uri = $1 ORDER BY issuer`,
      [edition.rows[0].uri]
    );
    expect(claims.rows).toEqual([
      { issuer: 'googlebooks', pages: 304, language: 'en' },
      { issuer: 'isbn13', pages: 304, language: 'en' }
    ]);

    const identifiers = await pool.query(
      'SELECT issuer, value FROM edition_identifiers WHERE edition_uri = $1 ORDER BY issuer',
      [edition.rows[0].uri]
    );
    expect(identifiers.rows).toEqual([
      { issuer: 'googlebooks', value: GOOGLE_VOLUME_ID },
      { issuer: 'isbn13', value: GOOGLE_ISBN }
    ]);

    const contributors = await pool.query(
      `SELECT c.name, ec.role FROM edition_contributors ec
       JOIN contributors c ON c.id = ec.contributor_id
       WHERE ec.edition_uri = $1`,
      [edition.rows[0].uri]
    );
    expect(contributors.rows).toEqual([{ name: 'Ursula K. Le Guin', role: 'A01' }]);

    const outbox = await pool.query('SELECT collection, op FROM pds_outbox WHERE uri = $1', [
      edition.rows[0].uri
    ]);
    expect(outbox.rows).toEqual([
      { collection: 'community.lexicon.media.book.edition', op: 'create' }
    ]);

    // Idempotent: a second resolution updates in place, never duplicates.
    const firstUri = edition.rows[0].uri;
    await tasks['catalog.resolve'](
      { identifier: { issuer: 'isbn13', value: GOOGLE_ISBN } },
      helpers
    );
    const after = await pool.query(
      "SELECT count(*)::int AS n FROM editions WHERE uri LIKE 'at://did:web:test.example/%'"
    );
    expect(after.rows[0].n).toBe(1);
    const same = await pool.query(
      "SELECT uri FROM editions WHERE uri LIKE 'at://did:web:test.example/%'"
    );
    expect(same.rows[0].uri, 'identity is the identifier bag, not the rkey').toBe(firstUri);
  } finally {
    await pool.query("DELETE FROM editions WHERE uri LIKE 'at://did:web:test.example/%'");
    await pool.query(
      `DELETE FROM contributors c
        WHERE c.name = 'Ursula K. Le Guin'
          AND NOT EXISTS (
            SELECT 1 FROM edition_contributors ec WHERE ec.contributor_id = c.id
          )`
    );
    await pool.query(
      `DELETE FROM publishers p
        WHERE p.name = 'Ace'
          AND NOT EXISTS (
            SELECT 1 FROM edition_identifier_publishers ep WHERE ep.publisher_id = p.id
          )`
    );
    await releaseTestEntityUris(pool, 'did:web:test.example');
    await pool.query("DELETE FROM pds_outbox WHERE uri LIKE 'at://did:web:test.example/%'");
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
  const prefix = `at://${publisherDid}/community.lexicon.media.book.edition/`;

  try {
    await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`at://${publisherDid}/%`]);
    await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`at://${publisherDid}/%`]);

    await tasks['catalog.resolve'](
      { identifier: { issuer: 'isbn13', value: PLC_ISBN } },
      helpers
    );

    const edition = await pool.query('SELECT uri, rkey, title FROM editions WHERE uri LIKE $1', [
      `at://${publisherDid}/%`
    ]);
    expect(edition.rowCount).toBe(1);
    expect(edition.rows[0].uri.startsWith(prefix), edition.rows[0].uri).toBeTruthy();
    assertTid(edition.rows[0].rkey);
    expect(edition.rows[0].title).toBe('PLC Authority Edition');

    const outbox = await pool.query('SELECT collection, op FROM pds_outbox WHERE uri = $1', [
      edition.rows[0].uri
    ]);
    expect(outbox.rows).toEqual([
      { collection: 'community.lexicon.media.book.edition', op: 'create' }
    ]);

    // A different identifier bag mints a different TID under the same authority.
    await tasks['catalog.resolve'](
      { identifier: { issuer: 'goodreads', value: GOODREADS_BOOK_ID } },
      helpers
    );
    const editions = await pool.query(
      'SELECT rkey FROM editions WHERE uri LIKE $1 ORDER BY rkey',
      [`at://${publisherDid}/%`]
    );
    expect(editions.rowCount).toBe(2);
    for (const row of editions.rows) assertTid(row.rkey);
    expect(new Set(editions.rows.map((row) => row.rkey)).size).toBe(2);
  } finally {
    await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`at://${publisherDid}/%`]);
    await pool.query(
      `DELETE FROM contributors c
        WHERE c.name = 'Ursula K. Le Guin'
          AND NOT EXISTS (
            SELECT 1 FROM edition_contributors ec WHERE ec.contributor_id = c.id
          )`
    );
    await pool.query(
      `DELETE FROM publishers p
        WHERE p.name = 'Ace'
          AND NOT EXISTS (
            SELECT 1 FROM edition_identifier_publishers ep WHERE ep.publisher_id = p.id
          )`
    );
    await releaseTestEntityUris(pool, publisherDid);
    await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`at://${publisherDid}/%`]);
    await pool.query('DELETE FROM google_books_cache WHERE key LIKE $1', [`${baseUrl}/%`]);
    await pool.end();
  }
});

test('search falls back to Goodreads when ISBNdb is unconfigured and Google finds nothing', async () => {
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

    openlibraryRequests = 0;
    goodreadsRequests = 0;
    await tasks['catalog.search']({ title: 'Left Hand' }, helpers);

    const edition = await pool.query(
      "SELECT rkey, title, cover_url FROM editions WHERE uri LIKE 'at://did:web:test.example/%'"
    );
    expect(edition.rowCount).toBe(1);
    assertTid(edition.rows[0].rkey);
    expect(edition.rows[0].title).toBe('The Left Hand of Darkness');
    expect(edition.rows[0].cover_url).toBe(`https://img.example/${GOODREADS_BOOK_ID}.jpg`);
    expect(goodreadsRequests, 'Goodreads answers before OpenLibrary').toBe(1);
    expect(openlibraryRequests, 'OpenLibrary is not reached when Goodreads answers').toBe(0);
  } finally {
    await pool.query("DELETE FROM editions WHERE uri LIKE 'at://did:web:test.example/%'");
    await pool.query(
      `DELETE FROM contributors c
        WHERE c.name = 'Ursula K. Le Guin'
          AND NOT EXISTS (
            SELECT 1 FROM edition_contributors ec WHERE ec.contributor_id = c.id
          )`
    );
    await releaseTestEntityUris(pool, 'did:web:test.example');
    await pool.query("DELETE FROM pds_outbox WHERE uri LIKE 'at://did:web:test.example/%'");
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

    await tasks['catalog.isbn']({ isbn: ISBNDB_ISBN }, helpers);

    const edition = await pool.query(
      "SELECT uri, rkey, title, cover_url FROM editions WHERE uri LIKE 'at://did:web:isbn-direct.example/%'"
    );
    expect(edition.rowCount).toBe(1);
    assertTid(edition.rows[0].rkey);
    expect(edition.rows[0].title).toBe('Direct Hydration Volume');
    expect(edition.rows[0].cover_url).toBe('https://img.example/direct.jpg');

    const claims = await pool.query(
      `SELECT issuer, pages, language FROM edition_identifier_info
        WHERE edition_uri = $1 ORDER BY issuer`,
      [edition.rows[0].uri]
    );
    expect(claims.rows).toEqual([{ issuer: 'isbn13', pages: 200, language: 'en' }]);

    const identifiers = await pool.query(
      'SELECT issuer, value FROM edition_identifiers WHERE edition_uri = $1 ORDER BY issuer',
      [edition.rows[0].uri]
    );
    expect(identifiers.rows).toEqual([{ issuer: 'isbn13', value: ISBNDB_ISBN }]);

    const outbox = await pool.query('SELECT collection, op FROM pds_outbox WHERE uri = $1', [
      edition.rows[0].uri
    ]);
    expect(outbox.rows).toEqual([
      { collection: 'community.lexicon.media.book.edition', op: 'create' }
    ]);

    // A direct by-ISBN call, not the generic search path.
    expect(isbndbRequests).toBe(1);
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
  expect(providers.providers.isbndb).toBe(null);
  const tasks = createTasks({ pool, providers, publisherHost: 'isbn-fallback.example' });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await cleanupHydrationRows(pool, 'isbn-fallback.example');
    isbndbRequests = 0;

    await tasks['catalog.isbn']({ isbn: GOOGLE_ISBN }, helpers);

    const edition = await pool.query(
      "SELECT rkey, title FROM editions WHERE uri LIKE 'at://did:web:isbn-fallback.example/%'"
    );
    expect(edition.rowCount).toBe(1);
    assertTid(edition.rows[0].rkey);
    expect(edition.rows[0].title).toBe('The Left Hand of Darkness');

    // Without a key the fallback never reaches ISBNdb.
    expect(isbndbRequests).toBe(0);
  } finally {
    await cleanupHydrationRows(pool, 'isbn-fallback.example');
    await pool.end();
  }
});

test('catalog.isbn falls back to the resolve chain when ISBNdb has no record', async () => {
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
  const tasks = createTasks({ pool, providers, publisherHost: 'isbn-empty.example' });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await cleanupHydrationRows(pool, 'isbn-empty.example');
    isbndbRequests = 0;
    googleRequests = 0;

    await tasks['catalog.isbn']({ isbn: GOOGLE_ISBN }, helpers);

    const edition = await pool.query(
      "SELECT rkey, title FROM editions WHERE uri LIKE 'at://did:web:isbn-empty.example/%'"
    );
    expect(edition.rowCount).toBe(1);
    assertTid(edition.rows[0].rkey);
    expect(edition.rows[0].title).toBe('The Left Hand of Darkness');

    // ISBNdb was asked directly (empty), then again by the resolve chain
    // (served from its cache), so only one HTTP request reached the stub.
    expect(isbndbRequests).toBe(1);
    expect(googleRequests >= 1, 'Google Books must be reached after an empty ISBNdb').toBeTruthy();
  } finally {
    await cleanupHydrationRows(pool, 'isbn-empty.example');
    await pool.end();
  }
});

test('search tries ISBNdb first and never reaches Google when it returns candidates', async () => {
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
  const tasks = createTasks({ pool, providers, publisherHost: 'search-order.example' });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await cleanupHydrationRows(pool, 'search-order.example');
    isbndbRequests = 0;
    googleRequests = 0;
    goodreadsRequests = 0;

    await tasks['catalog.search']({ title: 'isbndb-first' }, helpers);

    const edition = await pool.query(
      "SELECT rkey, title FROM editions WHERE uri LIKE 'at://did:web:search-order.example/%'"
    );
    expect(edition.rows.map((row) => row.title), 'only the ISBNdb candidate is ingested').toEqual(['ISBNdb First Volume']);
    assertTid(edition.rows[0].rkey);
    expect(isbndbRequests, 'ISBNdb search is called').toBe(1);
    expect(googleRequests, 'Google Books must not be called').toBe(0);
    expect(goodreadsRequests, 'Goodreads must not be called').toBe(0);
  } finally {
    await cleanupHydrationRows(pool, 'search-order.example');
    await pool.end();
  }
});

test('search falls back to Google on an empty ISBNdb, then to Goodreads', async () => {
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
  const tasks = createTasks({ pool, providers, publisherHost: 'search-empty.example' });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await cleanupHydrationRows(pool, 'search-empty.example');
    isbndbRequests = 0;
    googleRequests = 0;
    goodreadsRequests = 0;

    await tasks['catalog.search']({ title: 'google-fills' }, helpers);
    expect(isbndbRequests, 'ISBNdb is tried first').toBe(1);
    expect(googleRequests, 'Google is called when ISBNdb is empty').toBe(1);
    expect(goodreadsRequests, 'Goodreads is not reached when Google answers').toBe(0);

    const fromGoogle = await pool.query(
      "SELECT title FROM editions WHERE uri LIKE 'at://did:web:search-empty.example/%'"
    );
    expect(fromGoogle.rows.map((row) => row.title)).toEqual(['The Left Hand of Darkness']);

    await tasks['catalog.search']({ title: 'isbndb-empty' }, helpers);
    expect(isbndbRequests, 'ISBNdb is tried for the second search').toBe(2);
    expect(googleRequests, 'Google is called for the second search').toBe(2);
    expect(goodreadsRequests, 'Goodreads fills the gap when Google is empty too').toBe(1);

    const titles = await pool.query(
      "SELECT title FROM editions WHERE uri LIKE 'at://did:web:search-empty.example/%' ORDER BY title"
    );
    expect(titles.rows.map((row) => row.title)).toEqual([
      'The Left Hand of Darkness',
      'The Left Hand of Darkness'
    ]);
  } finally {
    await cleanupHydrationRows(pool, 'search-empty.example');
    await pool.end();
  }
});

test('search ingests at most 50 candidates', async () => {
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
  const tasks = createTasks({ pool, providers, publisherHost: 'cap.example' });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await cleanupHydrationRows(pool, 'cap.example');
    isbndbRequests = 0;
    googleRequests = 0;

    await tasks['catalog.search']({ title: 'cap-test' }, helpers);

    const editions = await pool.query(
      "SELECT rkey FROM editions WHERE uri LIKE 'at://did:web:cap.example/%'"
    );
    expect(editions.rowCount, 'the provider returned 60 candidates').toBe(50);
    for (const row of editions.rows) assertTid(row.rkey);
    expect(new Set(editions.rows.map((row) => row.rkey)).size).toBe(50);
    expect(googleRequests).toBe(0);
  } finally {
    await cleanupHydrationRows(pool, 'cap.example');
    await pool.end();
  }
});

test('search tries OpenLibrary after Google and Goodreads', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const providers = createProviders({
    pool,
    env: {
      GOOGLE_BOOKS_BASE_URL: `${baseUrl}/google`,
      OPENLIBRARY_BASE_URL: `${baseUrl}/openlibrary`,
      GOODREADS_BASE_URL: `${baseUrl}/goodreads`
    }
  });
  const tasks = createTasks({ pool, providers, publisherHost: 'openlibrary.example' });
  const helpers = { logger: { info() {}, warn() {}, error() {} } };

  try {
    await cleanupHydrationRows(pool, 'openlibrary.example');
    googleRequests = 0;
    openlibraryRequests = 0;
    goodreadsRequests = 0;
    providerOrder.length = 0;

    await tasks['catalog.search']({ title: 'openlibrary-fills' }, helpers);

    const edition = await pool.query(
      "SELECT title FROM editions WHERE uri LIKE 'at://did:web:openlibrary.example/%'"
    );
    expect(edition.rows.map((row) => row.title)).toEqual(['OpenLibrary Fallback Volume']);
    expect(providerOrder).toEqual(['googlebooks', 'goodreads', 'openlibrary']);
    expect(googleRequests, 'Google is tried first').toBe(1);
    expect(goodreadsRequests, 'Goodreads is tried second').toBe(1);
    expect(openlibraryRequests, 'OpenLibrary is the final fallback').toBe(1);
  } finally {
    await cleanupHydrationRows(pool, 'openlibrary.example');
    await pool.end();
  }
});

test('ISBNdb reserves a call per cache miss and stops at the UTC daily limit', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await pool.query("DELETE FROM provider_daily_usage WHERE provider = 'isbndb'");
    isbndbRequests = 0;

    const providers = createProviders({
      pool,
      logger: silentLogger,
      env: {
        ISBNDB_API_KEY: 'test-key',
        ISBNDB_DAILY_LIMIT: '2',
        ISBNDB_BASE_URL: `${baseUrl}/isbndb`
      }
    });
    const isbndb = providers.providers.isbndb;
    expect(isbndb).toBeTruthy();

    const results = [];
    for (const isbn of [isbn13For(801), isbn13For(802), isbn13For(803)]) {
      results.push(await isbndb.byIsbn(isbn));
    }

    expect(isbndbRequests, 'exactly the quota reaches the stub network').toBe(2);
    expect(results[0]).toEqual([]);
    expect(results[1]).toEqual([]);
    expect(results[2], 'the exhausted call returns an empty result without HTTP').toEqual([]);

    const usage = await pool.query(
      "SELECT calls FROM provider_daily_usage WHERE provider = 'isbndb' " +
        "AND day = (now() AT TIME ZONE 'UTC')::date"
    );
    expect(usage.rows[0]?.calls).toBe(2);
  } finally {
    await pool.query("DELETE FROM provider_daily_usage WHERE provider = 'isbndb'");
    await pool.end();
  }
});

test('an ISBNdb cache hit does not consume the daily quota', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await pool.query("DELETE FROM provider_daily_usage WHERE provider = 'isbndb'");
    isbndbRequests = 0;

    const providers = createProviders({
      pool,
      logger: silentLogger,
      env: {
        ISBNDB_API_KEY: 'test-key',
        ISBNDB_DAILY_LIMIT: '2',
        ISBNDB_BASE_URL: `${baseUrl}/isbndb`
      }
    });
    const isbndb = providers.providers.isbndb;
    const isbn = isbn13For(811);

    await isbndb.byIsbn(isbn);
    await isbndb.byIsbn(isbn);

    expect(isbndbRequests, 'the second lookup is served from isbndb_cache').toBe(1);
    const usage = await pool.query(
      "SELECT calls FROM provider_daily_usage WHERE provider = 'isbndb' " +
        "AND day = (now() AT TIME ZONE 'UTC')::date"
    );
    expect(usage.rows[0]?.calls).toBe(1);
  } finally {
    await pool.query("DELETE FROM provider_daily_usage WHERE provider = 'isbndb'");
    await pool.end();
  }
});

test('a previous UTC day at the limit does not block today', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await pool.query("DELETE FROM provider_daily_usage WHERE provider = 'isbndb'");
    await pool.query(
      "INSERT INTO provider_daily_usage (provider, day, calls) " +
        "VALUES ('isbndb', (now() AT TIME ZONE 'UTC')::date - 1, 2)"
    );
    isbndbRequests = 0;

    const providers = createProviders({
      pool,
      logger: silentLogger,
      env: {
        ISBNDB_API_KEY: 'test-key',
        ISBNDB_DAILY_LIMIT: '2',
        ISBNDB_BASE_URL: `${baseUrl}/isbndb`
      }
    });

    await providers.providers.isbndb.byIsbn(isbn13For(821));

    expect(isbndbRequests, 'today starts a fresh budget after the UTC rollover').toBe(1);
    const today = await pool.query(
      "SELECT calls FROM provider_daily_usage WHERE provider = 'isbndb' " +
        "AND day = (now() AT TIME ZONE 'UTC')::date"
    );
    expect(today.rows[0]?.calls).toBe(1);
    const yesterday = await pool.query(
      "SELECT calls FROM provider_daily_usage WHERE provider = 'isbndb' " +
        "AND day = (now() AT TIME ZONE 'UTC')::date - 1"
    );
    expect(yesterday.rows[0]?.calls).toBe(2);
  } finally {
    await pool.query("DELETE FROM provider_daily_usage WHERE provider = 'isbndb'");
    await pool.end();
  }
});

test('the worker metrics endpoint exposes the ISBNdb quota gauges', async () => {
  const server = createMetricsServer({
    pool: { query: async () => ({ rows: [{ calls: 1234 }] }) },
    limit: 5000,
    logger: silentLogger
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);

    const body = await response.text();
    for (const name of [
      'bibliograph_isbndb_calls_today',
      'bibliograph_isbndb_daily_limit',
      'bibliograph_isbndb_calls_remaining'
    ]) {
      expect(body).toMatch(new RegExp(`^# HELP ${name} .+$`, 'm'));
      expect(body).toMatch(new RegExp(`^# TYPE ${name} gauge$`, 'm'));
    }
    expect(body).toMatch(/^bibliograph_isbndb_calls_today 1234$/m);
    expect(body).toMatch(/^bibliograph_isbndb_daily_limit 5000$/m);
    expect(body).toMatch(/^bibliograph_isbndb_calls_remaining 3766$/m);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a metrics database failure returns 500 instead of crashing', async () => {
  const server = createMetricsServer({
    pool: {
      query: async () => {
        throw new Error('database unavailable');
      }
    },
    limit: 5000,
    logger: silentLogger
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/metrics unavailable/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
