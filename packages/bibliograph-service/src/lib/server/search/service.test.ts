import test from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { pino } from 'pino';
import { SearchService, type SearchServiceDeps } from './service';
import type { PostgresSource } from './postgres-source';
import type { IsbndbSource } from './isbndb-source';
import type { GoogleBooksSource } from './google-books-source';
import type { GoogleBooksEnricher } from './google-books-enricher';
import type { GoodreadsSource } from './goodreads-source';
import type { WikidataEditionEnricher } from './wikidata-enricher';
import type { AuthorWikipediaEnricher } from './wikipedia-enricher';
import type { IsbndbEnricher, IsbndbWorkEnricher } from './isbndb-enricher';
import type {
  SearchQuery,
  SearchResult,
  EditionItem,
  WorkItem,
  ContributorItem,
  PublisherItem,
} from './types';
import { providerIdentifier } from '../identifiers';

const log: Logger = pino({ level: 'silent' });

const baseEdition: EditionItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/gb.b9AOEAAAQBAJ',
  title: 'Test',
  identifiers: [providerIdentifier('googlebooks', 'https://books.google.com/books?id=b9AOEAAAQBAJ')],
  contributors: [],
  createdAt: new Date().toISOString(),
};

const baseWork: WorkItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/gb.w1w',
  title: 'Test',
  subjects: [],
  identifiers: [providerIdentifier('googlebooks', 'https://books.google.com/books?id=b9AOEAAAQBAJ')],
  contributors: [],
  createdAt: new Date().toISOString(),
};

const baseContributor: ContributorItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/gb.a-jane-doe',
  name: 'Jane Doe',
  aliases: [],
  identifiers: [providerIdentifier('wikidata', 'https://www.wikidata.org/entity/Q1234')],
  createdAt: new Date().toISOString(),
};

function makeFakePostgres(result: SearchResult<EditionItem | WorkItem | ContributorItem>): PostgresSource {
  return {
    searchEditions: async (_q: SearchQuery) => result as SearchResult<EditionItem>,
    searchWorks: async (_q: SearchQuery) => result as SearchResult<WorkItem>,
    searchContributors: async (_q: SearchQuery) => result as SearchResult<ContributorItem>,
    searchPublishers: async (_q: SearchQuery) => ({ items: [], total: 0 }) as SearchResult<PublisherItem>,
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

function makeFakeGoogleBooksSource(): GoogleBooksSource {
  return {
    searchEditions: async () => ({ items: [], total: 0 }),
    searchWorks: async () => ({ items: [], total: 0 }),
  } as unknown as GoogleBooksSource;
}

function makeFakeGoodreadsSource(
  result: SearchResult<EditionItem> = { items: [], total: 0 },
): GoodreadsSource {
  return {
    searchEditions: async () => result,
  } as unknown as GoodreadsSource;
}

function makeFakeIsbndbEnricher(): IsbndbEnricher {
  return {
    enrich: async <T>(items: T[]) => items,
  } as unknown as IsbndbEnricher;
}

function makeFakeIsbndbWorkEnricher(): { enrich: IsbndbWorkEnricher['enrich']; captures: WorkItem[] } {
  const captures: WorkItem[] = [];
  return {
    captures,
    enrich: (async (items: WorkItem[], _log: Logger) => {
      captures.push(...items);
      return items;
    }) as unknown as IsbndbWorkEnricher['enrich'],
  };
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

function mergeFakes(
  fakes: { source: IsbndbSource; calls: SearchQuery[] },
): IsbndbSource & { calls: SearchQuery[] } {
  return { ...fakes.source, calls: fakes.calls } as unknown as IsbndbSource & { calls: SearchQuery[] };
}

function buildDeps(
  fakes: Partial<{
    pg: PostgresSource;
    gb: GoogleBooksSource;
    ib: { source: IsbndbSource; calls: SearchQuery[] };
    gr: GoodreadsSource;
  }>,
): SearchServiceDeps {
  return {
    postgres: fakes.pg ?? makeFakePostgres({ items: [], total: 0 }),
    googleBooksSource: fakes.gb ?? makeFakeGoogleBooksSource(),
    goodreadsSource: fakes.gr ?? makeFakeGoodreadsSource(),
    isbndbSource: fakes.ib ? mergeFakes(fakes.ib) : makeFakeIsbndbSource().source,
    googleBooks: { enrich: makeFakeGoogleBooks().enrich } as GoogleBooksEnricher,
    isbndbEnricher: makeFakeIsbndbEnricher(),
    isbndbWorkEnricher: makeFakeIsbndbWorkEnricher() as unknown as IsbndbWorkEnricher,
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
      providerIdentifier('goodreads', 'https://www.goodreads.com/book/show/23692271'),
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

test('searchEditions: a postgres-only match is returned without running the remote enrichers', async () => {
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
  assert.equal(gb.captures.length, 0, 'local rows are never enriched from upstream');
});

test('searchEditions: Google Books items run the whole edition enricher chain', async () => {
  const gb = makeFakeGoogleBooks();
  const aw = makeFakeAuthorWiki();
  const wd = makeFakeWikidataEdition();
  const gbSource = {
    searchEditions: async () => ({ items: [baseEdition], total: 1 }),
    searchWorks: async () => ({ items: [], total: 0 }),
  } as unknown as GoogleBooksSource;
  const svc = new SearchService(
    {
      ...buildDeps({ gb: gbSource }),
      googleBooks: { enrich: gb.enrich } as GoogleBooksEnricher,
      authorWikipedia: aw as unknown as AuthorWikipediaEnricher,
      wikidataEdition: wd as unknown as WikidataEditionEnricher,
    },
    log,
  );

  const r = await svc.searchEditions({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(gb.captures.length, 1, 'Google Books enricher should run on GB results');
  assert.equal(aw.captures.length, 1, 'author Wikipedia enricher should run on GB results');
  assert.equal(wd.captures.length, 1, 'Wikidata enricher should run on GB results');
});

test('searchEditions: GB degraded + isbn:q → ISBNdb fallback', async () => {
  const ib = makeFakeIsbndbSource({ items: [baseEdition], total: 1 });
  const gbDegraded = {
    searchEditions: async () => ({ items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } }),
    searchWorks: async () => ({ items: [], total: 0 }),
  } as unknown as GoogleBooksSource;
  const svc = new SearchService(
    buildDeps({ ib, gb: gbDegraded }),
    log,
  );

  const r = await svc.searchEditions({ q: 'isbn:9781607785927', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(ib.calls.length, 1, 'ISBNdb should be called when GB fails for ISBN-like q');
  assert.equal(r.degraded?.upstream, 'googlebooks');
});

test('searchEditions: GB degraded + non-ISBN q → ISBNdb skipped', async () => {
  const ib = makeFakeIsbndbSource();
  let ibCalled = false;
  ib.source.searchEditions = async (q: SearchQuery) => { ibCalled = true; return { items: [], total: 0, degraded: { upstream: 'isbndb', reason: 'non_isbn_query' } }; };
  const gbDegraded = {
    searchEditions: async () => ({ items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } }),
    searchWorks: async () => ({ items: [], total: 0 }),
  } as unknown as GoogleBooksSource;
  const svc = new SearchService(
    buildDeps({ ib, gb: gbDegraded }),
    log,
  );

  const r = await svc.searchEditions({ q: 'sapiens', limit: 10 });
  assert.equal(r.items.length, 0);
  assert.equal(ibCalled, false, 'ISBNdb should not be called for non-ISBN q');
  assert.equal(r.degraded?.upstream, 'googlebooks');
});

test('searchEditions: GB success → ISBNdb not called', async () => {
  const ib = makeFakeIsbndbSource();
  const svc = new SearchService(
    {
      ...buildDeps({
        gb: {
          searchEditions: async () => ({ items: [baseEdition], total: 1 }),
          searchWorks: async () => ({ items: [], total: 0 }),
        } as unknown as GoogleBooksSource,
        ib,
      }),
    },
    log,
  );

  await svc.searchEditions({ q: 'isbn:9781607785927', limit: 10 });
  assert.equal(ib.calls.length, 0, 'ISBNdb should not be called when GB succeeds');
});

test('searchWorks: Google Books items run the work enricher chain', async () => {
  const ibw = makeFakeIsbndbWorkEnricher();
  const wd = makeFakeWikidataEdition();
  const gbSource = {
    searchEditions: async () => ({ items: [], total: 0 }),
    searchWorks: async () => ({ items: [baseWork], total: 1 }),
  } as unknown as GoogleBooksSource;
  const svc = new SearchService(
    {
      ...buildDeps({ gb: gbSource }),
      isbndbWorkEnricher: ibw as unknown as IsbndbWorkEnricher,
      wikidataEdition: wd as unknown as WikidataEditionEnricher,
    },
    log,
  );

  const r = await svc.searchWorks({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(ibw.captures.length, 1);
  assert.equal(wd.captures.length, 1);
});

test('searchWorks: GB degraded + isbn:q → ISBNdb fallback', async () => {
  const ib = makeFakeIsbndbSource({ items: [], total: 0 }, { items: [baseWork], total: 1 });
  const gbDegraded = {
    searchEditions: async () => ({ items: [], total: 0 }),
    searchWorks: async () => ({ items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } }),
  } as unknown as GoogleBooksSource;
  const svc = new SearchService(
    buildDeps({ ib, gb: gbDegraded }),
    log,
  );

  const r = await svc.searchWorks({ q: 'isbn:9781607785927', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(ib.calls.length, 1, 'ISBNdb works endpoint should be called for ISBN-like q');
  assert.equal(r.degraded?.upstream, 'googlebooks');
});

test('searchContributors: an id-only query is answered from postgres', async () => {
  let pgQuery: SearchQuery | undefined;
  const pgStub: PostgresSource = {
    searchEditions: async () => ({ items: [], total: 0 }),
    searchWorks: async () => ({ items: [], total: 0 }),
    searchContributors: async (q: SearchQuery) => {
      pgQuery = q;
      return { items: [baseContributor], total: 1 };
    },
    searchPublishers: async () => ({ items: [], total: 0 }),
  } as unknown as PostgresSource;
  const svc = new SearchService(buildDeps({ pg: pgStub }), log);

  const r = await svc.searchContributors({ id: ['https://www.wikidata.org/entity/Q1234'], limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]?.uri, baseContributor.uri);
  assert.deepEqual(pgQuery?.id, ['https://www.wikidata.org/entity/Q1234']);
});

test('searchContributors: drops empty/whitespace names from postgres results', async () => {
  const emptyLocal: ContributorItem = { ...baseContributor, uri: 'at://x/contributor/empty', name: '' };
  const blankLocal: ContributorItem = { ...baseContributor, uri: 'at://x/contributor/blank', name: '   ' };
  const svc = new SearchService(
    buildDeps({ pg: makeFakePostgres({ items: [baseContributor, emptyLocal, blankLocal], total: 3 }) }),
    log,
  );

  const r = await svc.searchContributors({ limit: 10 });

  assert.deepEqual(r.items.map((i) => i.name), ['Jane Doe']);
});

test('searchContributors: id-only path drops empty names instead of returning them', async () => {
  const svc = new SearchService(
    buildDeps({ pg: makeFakePostgres({ items: [{ ...baseContributor, name: '' }], total: 1 }) }),
    log,
  );

  const r = await svc.searchContributors({ id: ['https://www.wikidata.org/entity/Q1234'], limit: 10 });

  assert.equal(r.items.length, 0);
});

test('searchEditions: forwards lang to postgres and GB sources', async () => {
  const lang = ['en-US', 'fr'] as const;
  let pgQuery: SearchQuery | undefined;
  let gbQuery: SearchQuery | undefined;
  const pgStub: PostgresSource = {
    searchEditions: async (q: SearchQuery) => { pgQuery = q; return { items: [], total: 0 }; },
    searchWorks: async () => ({ items: [], total: 0 }),
    searchContributors: async () => ({ items: [], total: 0 }),
    searchPublishers: async () => ({ items: [], total: 0 }),
  } as unknown as PostgresSource;
  const gbStub = {
    searchEditions: async (q: SearchQuery) => { gbQuery = q; return { items: [], total: 0 }; },
    searchWorks: async () => ({ items: [], total: 0 }),
  } as unknown as GoogleBooksSource;
  const svc = new SearchService(
    {
      ...buildDeps({ pg: pgStub, gb: gbStub }),
    },
    log,
  );

  await svc.searchEditions({ limit: 10, lang: [...lang] });

  assert.deepEqual(pgQuery?.lang, [...lang], 'postgres sees lang');
  assert.deepEqual(gbQuery?.lang, [...lang], 'GB sees lang');
});

test('searchPublishers: passes the postgres result through unchanged', async () => {
  const publishers: PublisherItem[] = [
    {
      uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.publisher/penguin',
      name: 'Penguin',
      identifiers: [providerIdentifier('wikidata', 'https://www.wikidata.org/entity/Q1330709')],
      createdAt: new Date().toISOString(),
    },
  ];
  const pgStub: PostgresSource = {
    searchEditions: async () => ({ items: [], total: 0 }),
    searchWorks: async () => ({ items: [], total: 0 }),
    searchContributors: async () => ({ items: [], total: 0 }),
    searchPublishers: async () => ({ items: publishers, total: 42 }),
  } as unknown as PostgresSource;
  const svc = new SearchService(buildDeps({ pg: pgStub }), log);

  const r = await svc.searchPublishers({ q: 'penguin', limit: 10 });

  assert.deepEqual(r.items, publishers);
  assert.equal(r.cursor, undefined);
  assert.equal(r.total, 42);
});
