import test from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { pino } from 'pino';
import { SearchService } from './service';
import type { PostgresSource } from './postgres-source';
import type { IsbndbSource } from './isbndb-source';
import type { GoogleBooksEnricher } from './google-books-enricher';
import type { GoodreadsSource } from './goodreads-source';
import type { GoogleBooksSource } from './google-books-source';
import type { IsbndbEnricher, IsbndbWorkEnricher } from './isbndb-enricher';
import type { WikidataEditionEnricher } from './wikidata-enricher';
import type { AuthorWikipediaEnricher } from './wikipedia-enricher';
import type {
  SearchQuery,
  SearchResult,
  EditionItem,
  WorkItem,
  ContributorItem,
  PublisherItem,
} from './types';

const log: Logger = pino({ level: 'silent' });

const baseEdition: EditionItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/gb.b9AOEAAAQBAJ',
  title: 'Test',
  identifiers: [{ uri: 'isbn:9781607785927', resource: 'isbn13' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

const baseWork: WorkItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/gb.wv9AOEAAAQBAJ',
  title: 'Test',
  subjects: [],
  identifiers: [{ uri: 'isbn:9781607785927', resource: 'isbn13' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

const baseContributor: ContributorItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/jane-doe',
  name: 'Jane Doe',
  aliases: [],
  identifiers: [{ uri: 'https://www.wikidata.org/entity/Q1', resource: 'wikidata' }],
  createdAt: new Date().toISOString(),
};

const basePublisher: PublisherItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.publisher/isbndb.9781607785927',
  name: 'Test Press',
  identifiers: [{ uri: 'isbn:9781607785927', resource: 'isbn13' }],
  createdAt: new Date().toISOString(),
};

function makeFakePostgres(result: SearchResult<EditionItem | WorkItem | ContributorItem>): PostgresSource {
  return {
    searchEditions: async (_q: SearchQuery) => result as SearchResult<EditionItem>,
    searchWorks: async (_q: SearchQuery) => result as SearchResult<WorkItem>,
    searchContributors: async (_q: SearchQuery) => result as SearchResult<ContributorItem>,
  } as unknown as PostgresSource;
}

function makeFakeGoogleBooks(): { enrich: GoogleBooksEnricher['enrich']; captures: EditionItem[] } {
  const captures: EditionItem[] = [];
  return {
    captures,
    enrich: (async (items: EditionItem[], _log: Logger) => {
      captures.push(...items);
      return items;
    }) as GoogleBooksEnricher['enrich'],
  };
}

function makeFakeAuthorWiki(): { enrich: AuthorWikipediaEnricher['enrich']; captures: (EditionItem | WorkItem)[] } {
  const captures: (EditionItem | WorkItem)[] = [];
  return {
    captures,
    enrich: (async (items: (EditionItem | WorkItem)[], _log: Logger) => {
      captures.push(...items);
      return items;
    }) as AuthorWikipediaEnricher['enrich'],
  };
}

function makeFakeWikidataEdition(): { enrich: WikidataEditionEnricher['enrich']; captures: (EditionItem | WorkItem)[] } {
  const captures: (EditionItem | WorkItem)[] = [];
  return {
    captures,
    enrich: (async (items: (EditionItem | WorkItem)[], _log: Logger) => {
      captures.push(...items);
      return items;
    }) as WikidataEditionEnricher['enrich'],
  };
}

function makeFakeGoogleBooksSource(
  editions: SearchResult<EditionItem> = { items: [], total: 0 },
  works: SearchResult<WorkItem> = { items: [], total: 0 },
) {
  return {
    searchEditions: async () => editions,
    searchWorks: async () => works,
  } as unknown as GoogleBooksSource;
}

function makeFakeGoodreadsSource(
  result: SearchResult<EditionItem> = { items: [], total: 0 },
): GoodreadsSource {
  return {
    searchEditions: async () => result,
  } as unknown as GoodreadsSource;
}

function makeFakeIsbndbEnricher() {
  return {
    enrich: async <T>(items: T[]) => items,
  } as unknown as IsbndbEnricher;
}

function makeFakeIsbndbWorkEnricher() {
  return {
    enrich: async <T>(items: T[]) => items,
  } as unknown as IsbndbWorkEnricher;
}

function makeFakeIsbndbSource(
  editions: SearchResult<EditionItem> = { items: [], total: 0 },
  works: SearchResult<WorkItem> = { items: [], total: 0 },
): { source: IsbndbSource; calls: SearchQuery[] } {
  const calls: SearchQuery[] = [];
  return {
    calls,
    source: {
      searchEditions: async (q: SearchQuery) => { calls.push(q); return editions; },
      searchWorks: async (q: SearchQuery) => { calls.push(q); return works; },
    } as unknown as IsbndbSource,
  };
}

function buildDeps(
  fakes: Partial<{
    pg: PostgresSource;
    gb: GoogleBooksSource;
    ib: { source: IsbndbSource; calls: SearchQuery[] };
    gr: GoodreadsSource;
  }>,
) {
  return {
    postgres: fakes.pg ?? makeFakePostgres({ items: [], total: 0 }),
    googleBooksSource: fakes.gb ?? makeFakeGoogleBooksSource(),
    goodreadsSource: fakes.gr ?? makeFakeGoodreadsSource(),
    isbndbSource: fakes.ib ? fakes.ib.source : makeFakeIsbndbSource().source,
    googleBooks: { enrich: makeFakeGoogleBooks().enrich } as GoogleBooksEnricher,
    isbndbEnricher: makeFakeIsbndbEnricher(),
    isbndbWorkEnricher: makeFakeIsbndbWorkEnricher(),
    authorWikipedia: makeFakeAuthorWiki() as unknown as AuthorWikipediaEnricher,
    wikidataEdition: makeFakeWikidataEdition() as unknown as WikidataEditionEnricher,
  };
}

test('searchEditions: Goodreads fills the result set after primary sources', async () => {
  const grEdition: EditionItem = {
    ...baseEdition,
    uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/gr.23692271',
    title: 'Sapiens',
    identifiers: [
      { uri: 'https://www.goodreads.com/book/show/23692271', resource: 'goodreads' },
    ],
  };
  const svc = new SearchService(
    buildDeps({ gr: makeFakeGoodreadsSource({ items: [grEdition], total: 6749 }) }),
    log,
  );
  const r = await svc.searchEditions({ q: 'sapiens', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]?.uri, grEdition.uri);
  assert.equal(r.total, 6749);
});

test('searchEditions: a blocked Goodreads source degrades instead of failing', async () => {
  const svc = new SearchService(
    buildDeps({
      gr: makeFakeGoodreadsSource({
        items: [],
        total: 0,
        degraded: { upstream: 'goodreads', reason: 'blocked' },
      }),
    }),
    log,
  );
  const r = await svc.searchEditions({ q: 'sapiens', limit: 10 });
  assert.equal(r.items.length, 0);
  assert.deepEqual(r.degraded, { upstream: 'goodreads', reason: 'blocked' });
});

test('searchEditions: postgres hit is served without a remote source', async () => {
  const gb = makeFakeGoogleBooks();
  const svc = new SearchService(
    {
      ...buildDeps({ pg: makeFakePostgres({ items: [baseEdition], total: 1 }) }),
      googleBooks: { enrich: gb.enrich } as GoogleBooksEnricher,
    },
    log,
  );

  const r = await svc.searchEditions({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]?.uri, baseEdition.uri);
});

test('searchEditions: no remote edition source leaves postgres as the answer', async () => {
  const svc = new SearchService(buildDeps({}), log);

  const r = await svc.searchEditions({ q: 'sapiens', limit: 10 });
  assert.equal(r.items.length, 0);
  assert.equal(r.total, 0);
});

test('searchEditions: GB results run every edition enricher', async () => {
  const gb = makeFakeGoogleBooks();
  const aw = makeFakeAuthorWiki();
  const wd = makeFakeWikidataEdition();
  const svc = new SearchService(
    {
      ...buildDeps({
        gb: makeFakeGoogleBooksSource({ items: [baseEdition], total: 1 }),
      }),
      googleBooks: { enrich: gb.enrich } as GoogleBooksEnricher,
      authorWikipedia: aw as unknown as AuthorWikipediaEnricher,
      wikidataEdition: wd as unknown as WikidataEditionEnricher,
    },
    log,
  );

  const r = await svc.searchEditions({ q: 'sapiens', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(gb.captures.length, 1, 'Google Books enricher should run on GB results');
  assert.equal(aw.captures.length, 1, 'author Wikipedia enricher should run on GB results');
  assert.equal(wd.captures.length, 1, 'Wikidata enricher should run on GB results');
});

test('searchEditions: GB degraded + isbn:q → ISBNdb fallback', async () => {
  const ib = makeFakeIsbndbSource({ items: [baseEdition], total: 1 });
  const gbDegraded = makeFakeGoogleBooksSource(
    { items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } },
  );
  const svc = new SearchService(buildDeps({ ib, gb: gbDegraded }), log);

  const r = await svc.searchEditions({ q: 'isbn:9781607785927', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(ib.calls.length, 1, 'ISBNdb should be called when GB fails for ISBN-like q');
  assert.equal(r.degraded?.upstream, 'googlebooks');
});

test('searchEditions: non-ISBN q never consults ISBNdb', async () => {
  const ib = makeFakeIsbndbSource({ items: [baseEdition], total: 1 });
  const svc = new SearchService(buildDeps({ ib }), log);

  const r = await svc.searchEditions({ q: 'sapiens', limit: 10 });
  assert.equal(r.items.length, 0);
  assert.equal(ib.calls.length, 0, 'ISBNdb should not be called for non-ISBN q');
});

test('searchEditions: GB success → ISBNdb not called', async () => {
  const ib = makeFakeIsbndbSource();
  const svc = new SearchService(
    buildDeps({
      gb: makeFakeGoogleBooksSource({ items: [baseEdition], total: 1 }),
      ib,
    }),
    log,
  );

  await svc.searchEditions({ q: 'isbn:9781607785927', limit: 10 });
  assert.equal(ib.calls.length, 0, 'ISBNdb should not be called when GB succeeds');
});

test('searchWorks: GB miss + isbn:q → ISBNdb fallback', async () => {
  const ib = makeFakeIsbndbSource({ items: [], total: 0 }, { items: [baseWork], total: 1 });
  const gbDegraded = makeFakeGoogleBooksSource(
    { items: [], total: 0 },
    { items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } },
  );
  const svc = new SearchService(buildDeps({ ib, gb: gbDegraded }), log);

  const r = await svc.searchWorks({ q: 'isbn:9781607785927', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(ib.calls.length, 1, 'ISBNdb works endpoint should be called for ISBN-like q');
});

test('searchWorks: no remote source leaves postgres as the answer', async () => {
  const svc = new SearchService(buildDeps({}), log);

  const r = await svc.searchWorks({ q: 'sapiens', limit: 10 });
  assert.equal(r.items.length, 0);
  assert.equal(r.total, 0);
});

test('searchContributors: served from postgres with no remote hop', async () => {
  const svc = new SearchService(
    buildDeps({ pg: makeFakePostgres({ items: [baseContributor], total: 1 }) }),
    log,
  );

  const r = await svc.searchContributors({ id: ['https://www.wikidata.org/entity/Q1'], limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]?.uri, baseContributor.uri);
});

test('searchContributors: keeps the cached portrait and forwards the cursor', async () => {
  const local: ContributorItem = { ...baseContributor, imageUrl: 'https://commons.test/jd.jpg' };
  const svc = new SearchService(
    buildDeps({ pg: makeFakePostgres({ items: [local], total: 7, cursor: 'c1' }) }),
    log,
  );

  const r = await svc.searchContributors({ q: 'jane', limit: 10 });

  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]?.imageUrl, 'https://commons.test/jd.jpg');
  assert.equal(r.cursor, 'c1');
  assert.equal(r.total, 7);
});

test('searchContributors: drops empty/whitespace names', async () => {
  const emptyLocal: ContributorItem = { ...baseContributor, uri: 'at://x/contributor/empty', name: '' };
  const blankLocal: ContributorItem = { ...baseContributor, uri: 'at://x/contributor/blank', name: '   ' };
  const svc = new SearchService(
    buildDeps({ pg: makeFakePostgres({ items: [baseContributor, emptyLocal, blankLocal], total: 3 }) }),
    log,
  );

  const r = await svc.searchContributors({ limit: 10 });

  assert.deepEqual(r.items.map((i) => i.name), ['Jane Doe']);
});

test('searchPublishers: served from postgres with no remote hop', async () => {
  const pg = {
    searchPublishers: async () => ({ items: [basePublisher], total: 1 }),
  } as unknown as PostgresSource;
  const svc = new SearchService(buildDeps({ pg }), log);

  const r = await svc.searchPublishers({ q: 'test press', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]?.name, 'Test Press');
  assert.equal(r.total, 1);
  assert.equal(r.cursor, undefined);
});

test('searchPublishers: a missing total reports 0 rather than undefined', async () => {
  const pg = {
    searchPublishers: async () => ({ items: [], total: undefined }),
  } as unknown as PostgresSource;
  const svc = new SearchService(buildDeps({ pg }), log);

  const r = await svc.searchPublishers({ limit: 10 });
  assert.equal(r.total, 0);
});

test('searchEditions: forwards lang to postgres and GB sources', async () => {
  const lang = ['en-US', 'fr'] as const;
  let pgQuery: SearchQuery | undefined;
  let gbQuery: SearchQuery | undefined;
  const pgStub: PostgresSource = {
    searchEditions: async (q: SearchQuery) => { pgQuery = q; return { items: [], total: 0 }; },
    searchWorks: async () => ({ items: [], total: 0 }),
    searchContributors: async () => ({ items: [], total: 0 }),
  } as unknown as PostgresSource;
  const gbStub = {
    searchEditions: async (q: SearchQuery) => { gbQuery = q; return { items: [], total: 0 }; },
    searchWorks: async () => ({ items: [], total: 0 }),
  } as unknown as GoogleBooksSource;
  const svc = new SearchService(buildDeps({ pg: pgStub, gb: gbStub }), log);

  await svc.searchEditions({ limit: 10, lang: [...lang] });

  assert.deepEqual(pgQuery?.lang, [...lang], 'postgres sees lang');
  assert.deepEqual(gbQuery?.lang, [...lang], 'GB sees lang');
});
