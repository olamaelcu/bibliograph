import test from 'node:test';
import assert from 'node:assert/strict';

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
  return {
    calls,
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
}

/** A fetch stub that answers one page per queued body. */
function pageFetcher(pages) {
  const urls = [];
  return {
    urls,
    async fetch(url) {
      urls.push(url);
      const body = pages.shift();
      assert.ok(body !== undefined, 'unexpected extra request');
      return { ok: true, status: 200, async json() { return body; } };
    }
  };
}

test('parseCatalogBook rejects a hand-written hive id and an empty title', () => {
  assert.equal(parseCatalogBook(catalogBook({ id: 'whatever' })), null);
  assert.equal(parseCatalogBook(catalogBook({ id: 'bk_abc' })), null);
  assert.equal(parseCatalogBook(catalogBook({ id: undefined })), null);
  assert.equal(parseCatalogBook(catalogBook({ title: '   ' })), null);
  assert.equal(parseCatalogBook(catalogBook({ title: undefined })), null);
  assert.equal(parseCatalogBook(null), null);
});

test('parseCatalogBook emits the hive id, a normalized ISBN and a Goodreads id', () => {
  const hyphenated = parseCatalogBook(
    catalogBook({ identifiers: { isbn13: '978-0-441-01359-3', goodreadsId: ' 1234 ' } })
  );
  assert.deepEqual(hyphenated.identifiers, [
    { issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' },
    { issuer: 'isbn13', value: '9780441013593' },
    { issuer: 'goodreads', value: '1234' }
  ]);

  // An ISBN-10 is converted rather than dropped.
  const tenDigit = parseCatalogBook(catalogBook({ identifiers: { isbn10: '0441013597' } }));
  assert.deepEqual(tenDigit.identifiers, [
    { issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' },
    { issuer: 'isbn13', value: '9780441013593' }
  ]);

  // No identifiers object at all still catalogues the book on its hive id.
  const bare = parseCatalogBook(catalogBook());
  assert.deepEqual(bare.identifiers, [{ issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' }]);

  // A blank Goodreads id is not an identifier.
  const blank = parseCatalogBook(catalogBook({ identifiers: { goodreadsId: '  ' } }));
  assert.deepEqual(blank.identifiers, [{ issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' }]);
});

test('parseCatalogBook splits the tab-separated author list and other separators', () => {
  const authors = (value) => parseCatalogBook(catalogBook({ authors: value })).contributors;

  // Bookhive stores authors tab-separated (`parseAuthors`), including holes.
  assert.deepEqual(authors('Ann Leckie\t\tBecky Chambers'), [
    { name: 'Ann Leckie' },
    { name: 'Becky Chambers' }
  ]);
  assert.deepEqual(authors('Jane Austen, Charlotte Brontë'), [
    { name: 'Jane Austen' },
    { name: 'Charlotte Brontë' }
  ]);
  assert.deepEqual(authors('Terry Pratchett & Neil Gaiman'), [
    { name: 'Terry Pratchett' },
    { name: 'Neil Gaiman' }
  ]);
  assert.deepEqual(authors('Ursula K. Le Guin and Ken Liu'), [
    { name: 'Ursula K. Le Guin' },
    { name: 'Ken Liu' }
  ]);
});

test('parseCatalogBook prefers the full cover and trims the title', () => {
  const candidate = parseCatalogBook(
    catalogBook({ title: '  A Book  ', cover: 'https://img.example/cover.jpg' })
  );
  assert.equal(candidate.title, 'A Book');
  assert.equal(candidate.coverUrl, 'https://img.example/cover.jpg');
  assert.equal(candidate.hiveId, 'bk_abc123');
  assert.equal(
    parseCatalogBook(catalogBook({ cover: '' })).coverUrl,
    'https://img.example/thumb.jpg'
  );
});

test('languageTags derives name -> tag from the catalog codes', () => {
  const tags = languageTags(['en', 'nl', 'es', 'ca', 'no', 'pt']);
  // Bookhive writes the ISO English name, `;`-separated alternative included.
  assert.equal(tags.get('english'), 'en');
  assert.equal(tags.get('dutch'), 'nl');
  assert.equal(tags.get('spanish'), 'es');
  assert.equal(tags.get('catalan'), 'ca');
  assert.equal(tags.get('norwegian'), 'no');
  assert.equal(tags.get('portuguese'), 'pt');
  assert.equal(tags.get('klingon'), undefined);
  // Junk codes are skipped rather than throwing.
  assert.equal(languageTags(['zzzz', '', null, 'x']).size, 0);
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

  assert.equal(candidate.description, 'A novel of manners.');
  assert.equal(candidate.pages, 320);
  assert.equal(candidate.language, 'en');
  assert.equal(candidate.publishedDate, '1813');
  assert.deepEqual(candidate.publisher, { name: 'T. Egerton' });
  // Series is edition-level, not a claim: it names the work's placement.
  assert.deepEqual(candidate.series, { name: 'The Novels' });
  // Everything above describes the identifier the record came through.
  assert.deepEqual(candidate.sourceIdentifier, { issuer: BOOKHIVE_ISSUER, value: 'bk_abc123' });
});

test('parseCatalogBook drops metadata it cannot publish as-is', () => {
  const languages = languageTags(['en']);
  const bare = parseCatalogBook(catalogBook(), { languages });
  assert.equal(bare.description, undefined);
  assert.equal(bare.pages, undefined);
  assert.equal(bare.language, undefined);
  assert.equal(bare.publishedDate, undefined);
  assert.equal(bare.publisher, undefined);
  assert.equal(bare.series, undefined);

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
  assert.equal(nonsense.language, undefined);
  assert.equal(nonsense.publishedDate, undefined);
  assert.equal(nonsense.pages, undefined);
  assert.equal(nonsense.description, undefined);
  assert.equal(nonsense.publisher, undefined);
  assert.equal(nonsense.series, undefined);

  // A row that already holds a tag keeps it.
  assert.equal(parseCatalogBook(catalogBook({ language: 'EN-gb' }), { languages }).language, 'en-gb');
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

  assert.deepEqual(page.records, [catalogBook()]);
  assert.equal(page.cursor, 'next');
  const url = new URL(fetcher.urls[0]);
  assert.equal(url.origin, 'https://pds.example');
  assert.equal(url.pathname, '/xrpc/com.atproto.repo.listRecords');
  assert.equal(url.searchParams.get('collection'), 'buzz.bookhive.catalogBook');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('cursor'), null);
});

test('fetchCatalogPage drops entries without a record body and the last cursor', async () => {
  const fetcher = pageFetcher([{ records: [{ uri: 'at://x/1' }, { value: catalogBook() }] }]);
  const page = await fetchCatalogPage({ fetchImpl: fetcher.fetch, pdsUrl: 'https://pds.example' });
  assert.deepEqual(page.records, [catalogBook()]);
  assert.equal(page.cursor, undefined);
});

test('bookhivePdsUrl honours the override', () => {
  assert.equal(bookhivePdsUrl({ BOOKHIVE_PDS_URL: ' https://mirror.example ' }), 'https://mirror.example');
  assert.match(bookhivePdsUrl({}), /^https:\/\//);
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

  assert.deepEqual(ingested, ['bk_knownhive,9780441013593,9', 'bk_freshhive']);
  assert.deepEqual(summary, {
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
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /language_aliases/);
  assert.equal(pool.calls.filter((call) => call.sql.includes('FROM edition_identifiers i')).length, 1);
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

  assert.deepEqual(seen, ['bk_onehive', 'bk_twohive', 'bk_threehive']);
  assert.deepEqual(summary, { pages: 2, seen: 3, skipped: 0, created: 2, updated: 0, failed: 1 });
  assert.equal(fetcher.urls.length, 2);
  assert.equal(new URL(fetcher.urls[1]).searchParams.get('cursor'), 'page2');
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

  assert.equal(summary.pages, 1);
  assert.equal(summary.cursor, 'more');
  assert.equal(fetcher.urls.length, 1);
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
  assert.deepEqual(counted, { created: 1, failed: 1, pages: 1, run: 1, skipped: 1 });
  assert.equal(counted.pages, summary.pages);
  assert.equal(counted.skipped, summary.skipped);
  assert.equal(counted.created, summary.created);
  assert.equal(counted.failed, summary.failed);
});

test('a run that dies mid-walk still counts as an attempted run', async () => {
  const metrics = createBookhiveMetrics();
  await assert.rejects(
    importBookhiveCatalog({
      pool: fakePool(),
      fetchImpl: async () => ({ ok: false, status: 500, async json() {} }),
      pdsUrl: 'https://pds.example',
      pages: 1,
      logger: { warn() {} },
      metrics,
      ingest: async () => undefined
    }),
    /answered 500/
  );
  assert.deepEqual(metrics.snapshot(), [{ result: 'run', count: 1 }]);
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

  assert.equal(ingested.length, 1);
  assert.deepEqual(summary, { pages: 1, seen: 1, skipped: 0, created: 0, updated: 1, failed: 0 });
  assert.equal(ingested[0].description, 'A description the catalog gained');
  assert.equal(ingested[0].language, 'en');
  assert.equal(ingested[0].publishedDate, '1969');
  assert.equal(ingested[0].pages, 320);
  assert.deepEqual(ingested[0].publisher, { name: 'Ace Books' });
  assert.deepEqual(ingested[0].series, { name: 'Hainish Cycle' });
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

  assert.deepEqual(summary, { pages: 1, seen: 1, skipped: 1, created: 0, updated: 0, failed: 0 });
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
  assert.deepEqual(withBlob.series, { name: 'UNIT: The New Series', position: '1.1' });
  assert.equal(withBlob.description, 'The Faerie Queene was the first epic in English.');

  const bare = parseCatalogBook(catalogBook({ series: 'The Green Mile' }), { languages });
  assert.deepEqual(bare.series, { name: 'The Green Mile' });

  // An empty position is not a position, and an unparsable blob is not a name.
  const noPosition = parseCatalogBook(
    catalogBook({ series: '{"title":"B.P.R.D.","position":""}' }),
    { languages }
  );
  assert.deepEqual(noPosition.series, { name: 'B.P.R.D.' });
  assert.equal(parseCatalogBook(catalogBook({ series: '{not json}' }), { languages }).series, undefined);
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
  assert.deepEqual(fetcher.urls, []);
  assert.deepEqual(summary, { pages: 0, seen: 0, skipped: 0, created: 0, updated: 0, failed: 0 });
});
