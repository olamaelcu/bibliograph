import { expect, test } from 'vitest';

import {
  BOOKHIVE_ISSUER,
  bookhivePdsUrl,
  createBookhiveMetrics,
  fetchCatalogPage,
  importBookhiveCatalog,
  languageTags,
  parseCatalogBook
} from '../lib/bookhive.js';

/** A catalog book as Bookhive writes one, trimmed to the fields that matter. */
function catalogBook(overrides = {}) {
  return {
    $type: 'buzz.bookhive.catalogBook',
    id: 'bk_abc123',
    title: 'A Book',
    authors: 'Ursula K. Le Guin',
    thumbnail: 'https://img.example/thumb.jpg',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

/** A pool that answers the identifier-set query from a fixture map. */
function fakePool(editions = {}) {
  const calls = [];
  const pool = {
    calls,
    // One entry per `connect()`: a test can assert the page transaction.
    clients: [],
    async connect() {
      const client = {
        queries: [],
        released: false,
        async query(sql) {
          client.queries.push(sql);
          return { rows: [] };
        },
        release() {
          client.released = true;
        }
      };
      pool.clients.push(client);
      return client;
    },
    async query(sql, values) {
      calls.push({ sql, values });
      // The walk reads the catalog's language codes once, before the first page.
      if (sql.includes('language_aliases')) {
        return { rows: [{ language: 'en' }, { language: 'nl' }, { language: 'no' }] };
      }
      const rows = [];
      for (const hiveId of values[0]) {
        const edition = editions[hiveId];
        if (!edition) continue;
        for (const identifier of edition.identifiers) {
          const onHiveRow = identifier.issuer === BOOKHIVE_ISSUER && identifier.value === hiveId;
          const claims = onHiveRow ? (edition.claims ?? {}) : {};
          rows.push({
            edition_uri: edition.uri,
            issuer: identifier.issuer,
            value: identifier.value,
            description: claims.description ?? null,
            language: claims.language ?? null,
            published_date: claims.publishedDate ?? null,
            pages: claims.pages ?? null,
            series_name: onHiveRow ? (edition.seriesName ?? null) : null,
            has_publisher: onHiveRow && edition.hasPublisher === true
          });
        }
      }
      return { rows };
    }
  };
  return pool;
}

/** A fetch stub that answers one page per queued body. */
function pageFetcher(pages) {
  const urls = [];
  return {
    urls,
    async fetch(url) {
      urls.push(url);
      const body = pages.shift();
      expect(body !== undefined, 'unexpected extra request').toBeTruthy();
      return { ok: true, status: 200, async json() { return body; } };
    }
  };
}

test('parseCatalogBook rejects a hand-written hive id and an empty title', () => {
  expect(parseCatalogBook(catalogBook({ id: 'whatever' }))).toBe(null);
  expect(parseCatalogBook(catalogBook({ id: 'bk_abc' }))).toBe(null);
  expect(parseCatalogBook(catalogBook({ id: undefined }))).toBe(null);
  expect(parseCatalogBook(catalogBook({ title: '   ' }))).toBe(null);
  expect(parseCatalogBook(catalogBook({ title: undefined }))).toBe(null);
  expect(parseCatalogBook(null)).toBe(null);
});

test('parseCatalogBook emits the hive id, a normalized ISBN and a Goodreads id', () => {
  const hyphenated = parseCatalogBook(
    catalogBook({ identifiers: { isbn13: '978-0-441-01359-3', goodreadsId: ' 1234 ' } })
  );
  expect(hyphenated.identifiers).toEqual([
    { issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' },
    { issuer: 'isbn13', value: '9780441013593' },
    { issuer: 'goodreads', value: '1234' }
  ]);

  // An ISBN-10 is converted rather than dropped.
  const tenDigit = parseCatalogBook(catalogBook({ identifiers: { isbn10: '0441013597' } }));
  expect(tenDigit.identifiers).toEqual([
    { issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' },
    { issuer: 'isbn13', value: '9780441013593' }
  ]);

  // No identifiers object at all still catalogues the book on its hive id.
  const bare = parseCatalogBook(catalogBook());
  expect(bare.identifiers).toEqual([{ issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' }]);

  // A blank Goodreads id is not an identifier.
  const blank = parseCatalogBook(catalogBook({ identifiers: { goodreadsId: '  ' } }));
  expect(blank.identifiers).toEqual([{ issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' }]);
});

test('parseCatalogBook splits the tab-separated author list and other separators', () => {
  const authors = (value) => parseCatalogBook(catalogBook({ authors: value })).contributors;

  // Bookhive stores authors tab-separated (`parseAuthors`), including holes.
  expect(authors('Ann Leckie\t\tBecky Chambers')).toEqual([
    { name: 'Ann Leckie' },
    { name: 'Becky Chambers' }
  ]);
  expect(authors('Jane Austen, Charlotte Brontë')).toEqual([
    { name: 'Jane Austen' },
    { name: 'Charlotte Brontë' }
  ]);
  expect(authors('Terry Pratchett & Neil Gaiman')).toEqual([
    { name: 'Terry Pratchett' },
    { name: 'Neil Gaiman' }
  ]);
  expect(authors('Ursula K. Le Guin and Ken Liu')).toEqual([
    { name: 'Ursula K. Le Guin' },
    { name: 'Ken Liu' }
  ]);
});

test('parseCatalogBook prefers the full cover and trims the title', () => {
  const candidate = parseCatalogBook(
    catalogBook({ title: '  A Book  ', cover: 'https://img.example/cover.jpg' })
  );
  expect(candidate.title).toBe('A Book');
  expect(candidate.coverUrl).toBe('https://img.example/cover.jpg');
  expect(candidate.hiveId).toBe('bk_abc123');
  expect(parseCatalogBook(catalogBook({ cover: '' })).coverUrl).toBe('https://img.example/thumb.jpg');
});

test('languageTags derives name -> tag from the catalog codes', () => {
  const tags = languageTags(['en', 'nl', 'es', 'ca', 'no', 'pt']);
  // Bookhive writes the ISO English name, `;`-separated alternative included.
  expect(tags.get('english')).toBe('en');
  expect(tags.get('dutch')).toBe('nl');
  expect(tags.get('spanish')).toBe('es');
  expect(tags.get('catalan')).toBe('ca');
  expect(tags.get('norwegian')).toBe('no');
  expect(tags.get('portuguese')).toBe('pt');
  expect(tags.get('klingon')).toBe(undefined);
  // Junk codes are skipped rather than throwing.
  expect(languageTags(['zzzz', '', null, 'x']).size).toBe(0);
});

test('parseCatalogBook carries description, pages, language, year, publisher and series', () => {
  const languages = languageTags(['en', 'nl']);
  const candidate = parseCatalogBook(
    catalogBook({
      description: '  A novel of manners.  ',
      numPages: 320,
      language: 'English',
      publicationYear: 1813,
      publisher: ' T. Egerton ',
      series: '  The Novels  '
    }),
    { languages }
  );

  expect(candidate.description).toBe('A novel of manners.');
  expect(candidate.pages).toBe(320);
  expect(candidate.language).toBe('en');
  expect(candidate.publishedDate).toBe('1813');
  expect(candidate.publisher).toEqual({ name: 'T. Egerton' });
  // Series is edition-level, not a claim: it names the work's placement.
  expect(candidate.series).toEqual({ name: 'The Novels' });
  // Everything above describes the identifier the record came through.
  expect(candidate.sourceIdentifier).toEqual({ issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' });
});

test('parseCatalogBook drops metadata it cannot publish as-is', () => {
  const languages = languageTags(['en']);
  const bare = parseCatalogBook(catalogBook(), { languages });
  expect(bare.description).toBe(undefined);
  expect(bare.pages).toBe(undefined);
  expect(bare.language).toBe(undefined);
  expect(bare.publishedDate).toBe(undefined);
  expect(bare.publisher).toBe(undefined);
  expect(bare.series).toBe(undefined);

  const nonsense = parseCatalogBook(
    catalogBook({
      language: 'Klingon',
      publicationYear: 12000,
      numPages: 0,
      description: '   ',
      publisher: '  ',
      series: ''
    }),
    { languages }
  );
  // An unknown language name, an impossible year and a zero page count are
  // dropped: the record must not carry an invalid claim.
  expect(nonsense.language).toBe(undefined);
  expect(nonsense.publishedDate).toBe(undefined);
  expect(nonsense.pages).toBe(undefined);
  expect(nonsense.description).toBe(undefined);
  expect(nonsense.publisher).toBe(undefined);
  expect(nonsense.series).toBe(undefined);

  // A row that already holds a tag keeps it.
  expect(parseCatalogBook(catalogBook({ language: 'EN-gb' }), { languages }).language).toBe('en-gb');
});

test('fetchCatalogPage lists the collection from the PDS and follows the cursor', async () => {
  const fetcher = pageFetcher([
    { records: [{ uri: 'at://x/1', value: catalogBook() }], cursor: 'next' }
  ]);
  const page = await fetchCatalogPage({
    limit: 50,
    fetchImpl: fetcher.fetch,
    pdsUrl: 'https://pds.example/'
  });

  expect(page.records).toEqual([catalogBook()]);
  expect(page.cursor).toBe('next');
  const url = new URL(fetcher.urls[0]);
  expect(url.origin).toBe('https://pds.example');
  expect(url.pathname).toBe('/xrpc/com.atproto.repo.listRecords');
  expect(url.searchParams.get('collection')).toBe('buzz.bookhive.catalogBook');
  expect(url.searchParams.get('limit')).toBe('50');
  expect(url.searchParams.get('cursor')).toBe(null);
});

test('fetchCatalogPage drops entries without a record body and the last cursor', async () => {
  const fetcher = pageFetcher([{ records: [{ uri: 'at://x/1' }, { value: catalogBook() }] }]);
  const page = await fetchCatalogPage({ fetchImpl: fetcher.fetch, pdsUrl: 'https://pds.example' });
  expect(page.records).toEqual([catalogBook()]);
  expect(page.cursor).toBe(undefined);
});

test('bookhivePdsUrl honours the override', () => {
  expect(bookhivePdsUrl({ BOOKHIVE_PDS_URL: ' https://mirror.example ' })).toBe('https://mirror.example');
  expect(bookhivePdsUrl({})).toMatch(/^https:\/\//);
});

test('importBookhiveCatalog skips fully known sets and ingests the rest once', async () => {
  const known = {
    bk_knownhive: {
      uri: 'at://did:plc:pub/community.lexicon.media.book.edition/known',
      identifiers: [
        { issuer: BOOKHIVE_ISSUER, value: 'bk_knownhive' },
        { issuer: 'isbn13', value: '9780441013593' }
      ]
    }
  };
  const fetcher = pageFetcher([
    {
      records: [
        { value: catalogBook({ id: 'bk_knownhive', identifiers: { isbn13: '978-0-441-01359-3' } }) },
        // A second identifier the edition does not carry yet: not a duplicate.
        { value: catalogBook({ id: 'bk_knownhive', title: 'Later Edition', identifiers: { isbn13: '9780441013593', goodreadsId: '9' } }) },
        { value: catalogBook({ id: 'bk_freshhive' }) },
        { value: catalogBook({ id: 'bad-id' }) }
      ]
    }
  ]);
  const pool = fakePool(known);
  const ingested = [];
  const summary = await importBookhiveCatalog({
    pool,
    fetchImpl: fetcher.fetch,
    pdsUrl: 'https://pds.example',
    pages: 5,
    logger: { warn() {} },
    async ingest(candidate) {
      ingested.push(candidate.identifiers.map((identifier) => identifier.value).join(','));
      return { uri: `at://edition/${candidate.hiveId}`, created: ingested.length === 1 };
    }
  });

  expect(ingested).toEqual(['bk_knownhive,9780441013593,9', 'bk_freshhive']);
  expect(summary).toEqual({
    pages: 1,
    seen: 4,
    // Only the first record's set is already complete; the second one adds a
    // Goodreads id, so its edition is rewritten rather than skipped.
    skipped: 1,
    created: 1,
    updated: 1,
    failed: 1
  });
  // One language read for the walk, then one identifier-set query per page —
  // never one per record.
  expect(pool.calls.length).toBe(2);
  expect(pool.calls[0].sql).toMatch(/language_aliases/);
  expect(pool.calls.filter((call) => call.sql.includes('FROM edition_identifiers i')).length).toBe(1);
});

test('importBookhiveCatalog keeps walking after a failing record and stops at the last page', async () => {
  const fetcher = pageFetcher([
    {
      records: [{ value: catalogBook({ id: 'bk_onehive' }) }, { value: catalogBook({ id: 'bk_twohive' }) }],
      cursor: 'page2'
    },
    { records: [{ value: catalogBook({ id: 'bk_threehive' }) }] }
  ]);
  const seen = [];
  const summary = await importBookhiveCatalog({
    pool: fakePool(),
    fetchImpl: fetcher.fetch,
    pdsUrl: 'https://pds.example',
    pages: 100,
    logger: { warn() {} },
    async ingest(candidate) {
      seen.push(candidate.hiveId);
      if (candidate.hiveId === 'bk_onehive') throw new Error('catalog exploded');
      return { uri: `at://edition/${candidate.hiveId}`, created: true };
    }
  });

  expect(seen).toEqual(['bk_onehive', 'bk_twohive', 'bk_threehive']);
  expect(summary).toEqual({ pages: 2, seen: 3, skipped: 0, created: 2, updated: 0, failed: 1 });
  expect(fetcher.urls.length).toBe(2);
  expect(new URL(fetcher.urls[1]).searchParams.get('cursor')).toBe('page2');
});

test('each record is its own transaction, with a savepoint for its failure boundary', async () => {
  const pool = fakePool();
  const summary = await importBookhiveCatalog({
    pool,
    fetchImpl: pageFetcher([
      {
        records: [
          { value: catalogBook({ id: 'bk_aaa111' }) },
          { value: catalogBook({ id: 'bk_bbb222' }) }
        ]
      }
    ]).fetch,
    pdsUrl: 'https://pds.example',
    pages: 1,
    logger: { warn() {} },
    async ingest(candidate, options) {
      // The import hands its per-record transaction down, so one book's work
      // commits before the next book starts.
      expect(options.client, 'ingest runs inside the record transaction').toBeTruthy();
      return { uri: `at://edition/${candidate.hiveId}`, created: true };
    }
  });

  expect(summary.created).toBe(2);
  const [client] = pool.clients;
  expect(client.queries).toEqual([
    'BEGIN',
    'SAVEPOINT record',
    'RELEASE SAVEPOINT record',
    'COMMIT',
    'BEGIN',
    'SAVEPOINT record',
    'RELEASE SAVEPOINT record',
    'COMMIT'
  ]);
  expect(client.released).toBe(true);
});

test('a failing record commits an empty transaction and the next record still lands', async () => {
  const pool = fakePool();
  const summary = await importBookhiveCatalog({
    pool,
    fetchImpl: pageFetcher([
      {
        records: [
          { value: catalogBook({ id: 'bk_aaa111' }) },
          { value: catalogBook({ id: 'bk_bbb222' }) }
        ]
      }
    ]).fetch,
    pdsUrl: 'https://pds.example',
    pages: 1,
    logger: { warn() {} },
    async ingest(candidate) {
      if (candidate.hiveId === 'bk_aaa111') throw new Error('catalog exploded');
      return { uri: `at://edition/${candidate.hiveId}`, created: true };
    }
  });

  expect({ created: summary.created, failed: summary.failed }).toEqual({ created: 1, failed: 1 });
  const [client] = pool.clients;
  expect(client.queries).toEqual([
    'BEGIN',
    'SAVEPOINT record',
    'ROLLBACK TO SAVEPOINT record',
    'COMMIT',
    'BEGIN',
    'SAVEPOINT record',
    'RELEASE SAVEPOINT record',
    'COMMIT'
  ]);
});

test('importBookhiveCatalog honours the page budget and reports the resume cursor', async () => {
  const fetcher = pageFetcher([{ records: [catalogBook()], cursor: 'more' }]);
  const summary = await importBookhiveCatalog({
    pool: fakePool(),
    fetchImpl: fetcher.fetch,
    pdsUrl: 'https://pds.example',
    pages: 1,
    logger: { warn() {} },
    async ingest(candidate) {
      return { uri: `at://edition/${candidate.hiveId}`, created: true };
    }
  });

  expect(summary.pages).toBe(1);
  expect(summary.cursor).toBe('more');
  expect(fetcher.urls.length).toBe(1);
});

test('importBookhiveCatalog counts what the run did for the scrape', async () => {
  const fetcher = pageFetcher([
    {
      records: [
        { value: catalogBook({ id: 'bk_knownhive', identifiers: { isbn13: '978-0-441-01359-3' } }) },
        { value: catalogBook({ id: 'bk_freshhive' }) },
        { value: catalogBook({ id: 'not-a-hive-id' }) }
      ]
    }
  ]);
  const metrics = createBookhiveMetrics();
  const summary = await importBookhiveCatalog({
    pool: fakePool({
      bk_knownhive: {
        uri: 'at://did:plc:pub/community.lexicon.media.book.edition/known',
        identifiers: [
          { issuer: BOOKHIVE_ISSUER, value: 'bk_knownhive' },
          { issuer: 'isbn13', value: '9780441013593' }
        ]
      }
    }),
    fetchImpl: fetcher.fetch,
    pdsUrl: 'https://pds.example',
    pages: 1,
    logger: { warn() {} },
    metrics,
    async ingest(candidate) {
      return { uri: `at://edition/${candidate.hiveId}`, created: true };
    }
  });

  // The counters mirror the returned summary, so a dashboard and the log line
  // can never disagree; `run` is recorded before the first request.
  const counted = Object.fromEntries(metrics.snapshot().map((row) => [row.result, row.count]));
  expect(counted).toEqual({ created: 1, failed: 1, pages: 1, run: 1, skipped: 1 });
  expect(counted.pages).toBe(summary.pages);
  expect(counted.skipped).toBe(summary.skipped);
  expect(counted.created).toBe(summary.created);
  expect(counted.failed).toBe(summary.failed);
});

test('a run that dies mid-walk still counts as an attempted run', async () => {
  const metrics = createBookhiveMetrics();
  await expect(importBookhiveCatalog({
      pool: fakePool(),
      fetchImpl: async () => ({ ok: false, status: 500, async json() {} }),
      pdsUrl: 'https://pds.example',
      pages: 1,
      logger: { warn() {} },
      metrics,
      ingest: async () => undefined
    })).rejects.toThrow(/answered 500/);
  expect(metrics.snapshot()).toEqual([{ result: 'run', count: 1 }]);
});

test('a complete identifier set is not enough when the catalog has metadata the row lacks', async () => {
  const known = {
    bk_richhive: {
      uri: 'at://did:plc:pub/community.lexicon.media.book.edition/rich',
      identifiers: [
        { issuer: BOOKHIVE_ISSUER, value: 'bk_richhive' },
        { issuer: 'isbn13', value: '9780441013593' }
      ],
      // The first import stored no claims: the edition is now re-ingested so the
      // description/pages/language/year reach the bookhive row.
      claims: {}
    }
  };
  const record = {
    value: catalogBook({
      id: 'bk_richhive',
      identifiers: { isbn13: '978-0-441-01359-3' },
      description: 'A description the catalog gained',
      numPages: 320,
      language: 'English',
      publicationYear: 1969,
      publisher: 'Ace Books',
      series: 'Hainish Cycle'
    })
  };
  const ingested = [];
  const summary = await importBookhiveCatalog({
    pool: fakePool(known),
    fetchImpl: pageFetcher([{ records: [record] }]).fetch,
    pdsUrl: 'https://pds.example',
    pages: 1,
    logger: { warn() {} },
    async ingest(candidate) {
      ingested.push(candidate);
      return { uri: known.bk_richhive.uri, created: false };
    }
  });

  expect(ingested.length).toBe(1);
  expect(summary).toEqual({ pages: 1, seen: 1, skipped: 0, created: 0, updated: 1, failed: 0 });
  expect(ingested[0].description).toBe('A description the catalog gained');
  expect(ingested[0].language).toBe('en');
  expect(ingested[0].publishedDate).toBe('1969');
  expect(ingested[0].pages).toBe(320);
  expect(ingested[0].publisher).toEqual({ name: 'Ace Books' });
  expect(ingested[0].series).toEqual({ name: 'Hainish Cycle' });
});

test('a row that already carries the catalog metadata is skipped', async () => {
  const known = {
    bk_richhive: {
      uri: 'at://did:plc:pub/community.lexicon.media.book.edition/rich',
      identifiers: [
        { issuer: BOOKHIVE_ISSUER, value: 'bk_richhive' },
        { issuer: 'isbn13', value: '9780441013593' }
      ],
      claims: {
        description: 'A description the catalog gained',
        language: 'en',
        publishedDate: '1969',
        pages: 320
      },
      seriesName: 'Hainish Cycle',
      hasPublisher: true
    }
  };
  const record = {
    value: catalogBook({
      id: 'bk_richhive',
      identifiers: { isbn13: '9780441013593' },
      description: 'A description the catalog gained',
      numPages: 320,
      language: 'English',
      publicationYear: 1969,
      publisher: 'Ace Books',
      series: 'Hainish Cycle'
    })
  };
  const summary = await importBookhiveCatalog({
    pool: fakePool(known),
    fetchImpl: pageFetcher([{ records: [record] }]).fetch,
    pdsUrl: 'https://pds.example',
    pages: 1,
    logger: { warn() {} },
    async ingest() {
      throw new Error('a complete book must not be re-ingested');
    }
  });

  expect(summary).toEqual({ pages: 1, seen: 1, skipped: 1, created: 0, updated: 0, failed: 0 });
});

test('parseCatalogBook reads Bookhive series blobs and strips HTML descriptions', () => {
  const languages = languageTags(['en']);
  // Bookhive stores Goodreads' series object as a JSON string, sometimes with no
  // position and sometimes with a fractional one.
  const withBlob = parseCatalogBook(
    catalogBook({
      series: '{"title":"UNIT: The New Series","position":"1.1","webUrl":"https://www.goodreads.com/series/165734"}',
      description: '<i>The Faerie Queene</i> was the first epic&#160;in English.'
    }),
    { languages }
  );
  expect(withBlob.series).toEqual({ name: 'UNIT: The New Series', position: '1.1' });
  expect(withBlob.description).toBe('The Faerie Queene was the first epic in English.');

  const bare = parseCatalogBook(catalogBook({ series: 'The Green Mile' }), { languages });
  expect(bare.series).toEqual({ name: 'The Green Mile' });

  // An empty position is not a position, and an unparsable blob is not a name.
  const noPosition = parseCatalogBook(
    catalogBook({ series: '{"title":"B.P.R.D.","position":""}' }),
    { languages }
  );
  expect(noPosition.series).toEqual({ name: 'B.P.R.D.' });
  expect(parseCatalogBook(catalogBook({ series: '{not json}' }), { languages }).series).toBe(undefined);
});

test('the walk stops between pages when the shutdown signal aborts', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = pageFetcher([{ records: [catalogBook()], cursor: 'more' }]);
  const summary = await importBookhiveCatalog({
    pool: fakePool(),
    fetchImpl: fetcher.fetch,
    pdsUrl: 'https://pds.example',
    pages: 100,
    logger: { warn() {} },
    signal: controller.signal,
    async ingest() {
      throw new Error('an aborted walk must not ingest');
    }
  });

  // Nothing fetched, nothing written: the idempotent walk resumes from page 1.
  expect(fetcher.urls).toEqual([]);
  expect(summary).toEqual({ pages: 0, seen: 0, skipped: 0, created: 0, updated: 0, failed: 0 });
});
