import test from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { pino } from 'pino';
import { SearchService } from './service';
import type { PostgresSource } from './postgres-source';
import type { OpenLibrarySource } from './open-library-source';
import type { IsbndbSource } from './isbndb-source';
import type { GoogleBooksEnricher } from './google-books-enricher';
import type { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './wikipedia-enricher';
import type {
  SearchQuery,
  SearchResult,
  EditionItem,
  WorkItem,
  ContributorItem,
} from './types';

const log: Logger = pino({ level: 'silent' });

const baseEdition: EditionItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.edition/ol.OL1M',
  title: 'Test',
  identifiers: [{ uri: 'https://openlibrary.org/books/OL1M', resource: 'openlibrary' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

const baseWork: WorkItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.work/ol.WOL1W',
  title: 'Test',
  subjects: [],
  identifiers: [{ uri: 'https://openlibrary.org/works/OL1W', resource: 'openlibrary' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

const baseContributor: ContributorItem = {
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.A1A',
  name: 'Jane Doe',
  aliases: [],
  identifiers: [{ uri: 'https://openlibrary.org/authors/OL1A', resource: 'openlibrary' }],
  createdAt: new Date().toISOString(),
};

function makeFakePostgres(result: SearchResult<EditionItem | WorkItem | ContributorItem>): PostgresSource {
  return {
    searchEditions: async (_q: SearchQuery) => result as SearchResult<EditionItem>,
    searchWorks: async (_q: SearchQuery) => result as SearchResult<WorkItem>,
    searchContributors: async (_q: SearchQuery) => result as SearchResult<ContributorItem>,
  } as unknown as PostgresSource;
}

function makeFakeOpenLibrary(
  editions: SearchResult<EditionItem>,
  works: SearchResult<WorkItem>,
  contributors: SearchResult<ContributorItem>,
): OpenLibrarySource {
  return {
    searchEditions: async (_q: SearchQuery) => editions,
    searchWorks: async (_q: SearchQuery) => works,
    searchContributors: async (_q: SearchQuery) => contributors,
  } as unknown as OpenLibrarySource;
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

function makeFakeContributorWiki(): { enrich: ContributorWikipediaEnricher['enrich']; captures: ContributorItem[] } {
  const captures: ContributorItem[] = [];
  return {
    captures,
    enrich: (async (items: ContributorItem[], _log: Logger) => {
      captures.push(...items);
      return items;
    }) as ContributorWikipediaEnricher['enrich'],
  };
}

function makeFakeGoogleBooksSource() {
  return {
    searchEditions: async () => ({ items: [], total: 0 }),
    searchWorks: async () => ({ items: [], total: 0 }),
  } as unknown as import('./google-books-source').GoogleBooksSource;
}

function makeFakeOpenLibraryEnricher() {
  return {
    enrich: async <T>(items: T[]) => items,
  } as unknown as import('./open-library-enricher').OpenLibraryEnricher;
}

function makeFakeIsbndbEnricher() {
  return {
    enrich: async <T>(items: T[]) => items,
  } as unknown as import('./isbndb-enricher').IsbndbEnricher;
}

function makeFakeIsbndbWorkEnricher() {
  return {
    enrich: async <T>(items: T[]) => items,
  } as unknown as import('./isbndb-enricher').IsbndbWorkEnricher;
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

function makeFakePublisherSource() {
  return {
    searchPublishers: async () => ({ items: [], total: 0 }),
  } as unknown as Pick<typeof import('../api/open-library'), 'searchPublishers'>;
}

function buildDeps(
  fakes: Partial<{
    pg: PostgresSource;
    ol: OpenLibrarySource;
    gb: import('./google-books-source').GoogleBooksSource;
    ib: { source: IsbndbSource; calls: SearchQuery[] };
  }>,
) {
  return {
    postgres: fakes.pg ?? makeFakePostgres({ items: [], total: 0 }),
    openLibrary: fakes.ol ?? makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [], total: 0 }),
    publisherSource: makeFakePublisherSource(),
    googleBooksSource: fakes.gb ?? makeFakeGoogleBooksSource(),
    isbndbSource: (fakes.ib ? mergeFakes(fakes.ib) : makeFakeIsbndbSource().source) as IsbndbSource,
    googleBooks: { enrich: makeFakeGoogleBooks().enrich } as GoogleBooksEnricher,
    openLibraryEnricher: makeFakeOpenLibraryEnricher(),
    isbndbEnricher: makeFakeIsbndbEnricher(),
    isbndbWorkEnricher: makeFakeIsbndbWorkEnricher(),
    authorWikipedia: makeFakeAuthorWiki() as unknown as AuthorWikipediaEnricher,
    contributorWikipedia: makeFakeContributorWiki() as unknown as ContributorWikipediaEnricher,
  };
}

test('searchEditions: postgres hit short-circuits OL', async () => {
  const emptyOl = makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [], total: 0 });
  const gb = makeFakeGoogleBooks();
  const svc = new SearchService(
    {
      ...buildDeps({ pg: makeFakePostgres({ items: [baseEdition], total: 1 }), ol: emptyOl }),
      googleBooks: { enrich: gb.enrich } as GoogleBooksEnricher,
    },
    log,
  );

  const r = await svc.searchEditions({ limit: 10 });
  assert.equal(r.items.length, 1);
});

test('searchEditions: postgres miss → OL → GB → author wiki', async () => {
  const gb = makeFakeGoogleBooks();
  const aw = makeFakeAuthorWiki();
  const svc = new SearchService(
    {
      ...buildDeps({
        pg: makeFakePostgres({ items: [], total: 0 }),
        ol: makeFakeOpenLibrary({ items: [baseEdition], total: 1 }, { items: [], total: 0 }, { items: [], total: 0 }),
      }),
      googleBooks: { enrich: gb.enrich } as GoogleBooksEnricher,
      authorWikipedia: aw as unknown as AuthorWikipediaEnricher,
    },
    log,
  );

  const r = await svc.searchEditions({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(gb.captures.length, 1, 'Google Books enricher should run on OL results');
  assert.equal(aw.captures.length, 1, 'author Wikipedia enricher should run on GB results');
});

test('searchEditions: GB degraded + isbn:q → ISBNdb fallback', async () => {
  const ib = makeFakeIsbndbSource({ items: [baseEdition], total: 1 });
  let olCalled = false;
  const ol = makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [], total: 0 });
  ol.searchEditions = async () => { olCalled = true; return { items: [], total: 0 }; };
  const gbDegraded = {
    searchEditions: async () => ({ items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } }),
    searchWorks: async () => ({ items: [], total: 0 }),
  } as unknown as import('./google-books-source').GoogleBooksSource;
  const svc = new SearchService(
    buildDeps({ ol, ib, gb: gbDegraded }),
    log,
  );

  const r = await svc.searchEditions({ q: 'isbn:9781607785927', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(ib.calls.length, 1, 'ISBNdb should be called when GB fails for ISBN-like q');
  assert.equal(olCalled, false, 'OL should be skipped when ISBNdb hit');
  assert.equal(r.degraded?.upstream, 'googlebooks');
});

test('searchEditions: GB degraded + non-ISBN q → ISBNdb skipped, OL called', async () => {
  const ib = makeFakeIsbndbSource();
  let ibCalled = false;
  ib.source.searchEditions = async (q: SearchQuery) => { ibCalled = true; return { items: [], total: 0, degraded: { upstream: 'isbndb', reason: 'non_isbn_query' } }; };
  let olCalled = false;
  const ol = makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [], total: 0 });
  ol.searchEditions = async () => { olCalled = true; return { items: [baseEdition], total: 1 }; };
  const svc = new SearchService(
    buildDeps({ ol, ib }),
    log,
  );

  const r = await svc.searchEditions({ q: 'sapiens', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(ibCalled, false, 'ISBNdb should not be called for non-ISBN q');
  assert.equal(olCalled, true, 'OL should be called when GB fails for non-ISBN q');
});

test('searchEditions: GB success → ISBNdb not called', async () => {
  const ib = makeFakeIsbndbSource();
  const svc = new SearchService(
    {
      ...buildDeps({
        gb: {
          searchEditions: async () => ({ items: [baseEdition], total: 1 }),
          searchWorks: async () => ({ items: [], total: 0 }),
        } as unknown as import('./google-books-source').GoogleBooksSource,
        ib,
      }),
    },
    log,
  );

  await svc.searchEditions({ q: 'isbn:9781607785927', limit: 10 });
  assert.equal(ib.calls.length, 0, 'ISBNdb should not be called when GB succeeds');
});

test('searchWorks: postgres miss → OL → isbnDb enrich', async () => {
  const svc = new SearchService(
    buildDeps({
      ol: makeFakeOpenLibrary({ items: [], total: 0 }, { items: [baseWork], total: 1 }, { items: [], total: 0 }),
    }),
    log,
  );

  const r = await svc.searchWorks({ limit: 10 });
  assert.equal(r.items.length, 1);
});

test('searchWorks: GB degraded + isbn:q → ISBNdb fallback', async () => {
  const ib = makeFakeIsbndbSource({ items: [], total: 0 }, { items: [baseWork], total: 1 });
  let olCalled = false;
  const ol = makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [], total: 0 });
  ol.searchWorks = async () => { olCalled = true; return { items: [], total: 0 }; };
  const gbDegraded = {
    searchEditions: async () => ({ items: [], total: 0 }),
    searchWorks: async () => ({ items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } }),
  } as unknown as import('./google-books-source').GoogleBooksSource;
  const svc = new SearchService(
    buildDeps({ ol, ib, gb: gbDegraded }),
    log,
  );

  const r = await svc.searchWorks({ q: 'isbn:9781607785927', limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(ib.calls.length, 1, 'ISBNdb works endpoint should be called for ISBN-like q');
  assert.equal(olCalled, false);
});

test('searchContributors: id-only skips OL (option B from design)', async () => {
  const emptyOl = makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [], total: 0 });
  let olContributorsCalled = false;
  emptyOl.searchContributors = async () => { olContributorsCalled = true; return { items: [], total: 0 }; };
  const svc = new SearchService(
    {
      ...buildDeps({ pg: makeFakePostgres({ items: [baseContributor], total: 1 }), ol: emptyOl }),
    },
    log,
  );

  const r = await svc.searchContributors({ id: ['https://openlibrary.org/authors/OL1A'], limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(olContributorsCalled, false, 'OL should not be called when id is provided without q');
});

test('searchContributors: postgres miss → OL → contributor wiki', async () => {
  const cw = makeFakeContributorWiki();
  const svc = new SearchService(
    {
      ...buildDeps({
        ol: makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [baseContributor], total: 1 }),
      }),
      contributorWikipedia: cw as unknown as ContributorWikipediaEnricher,
    },
    log,
  );

  const r = await svc.searchContributors({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(cw.captures.length, 1);
});

test('searchEditions: forwards lang to postgres, OL, and GB sources', async () => {
  const lang = ['en-US', 'fr'] as const;
  let pgQuery: SearchQuery | undefined;
  let olQuery: SearchQuery | undefined;
  let gbQuery: SearchQuery | undefined;
  const pgStub: PostgresSource = {
    searchEditions: async (q: SearchQuery) => { pgQuery = q; return { items: [], total: 0 }; },
    searchWorks: async () => ({ items: [], total: 0 }),
    searchContributors: async () => ({ items: [], total: 0 }),
  } as unknown as PostgresSource;
  const olStub: OpenLibrarySource = {
    searchEditions: async (q: SearchQuery) => { olQuery = q; return { items: [], total: 0 }; },
    searchWorks: async () => ({ items: [], total: 0 }),
    searchContributors: async () => ({ items: [], total: 0 }),
  } as unknown as OpenLibrarySource;
  const gbStub = {
    searchEditions: async (q: SearchQuery) => { gbQuery = q; return { items: [], total: 0 }; },
    searchWorks: async () => ({ items: [], total: 0 }),
  } as unknown as import('./google-books-source').GoogleBooksSource;
  const svc = new SearchService(
    {
      ...buildDeps({ pg: pgStub, ol: olStub, gb: gbStub }),
    },
    log,
  );

  await svc.searchEditions({ limit: 10, lang: [...lang] });

  assert.deepEqual(pgQuery?.lang, [...lang], 'postgres sees lang');
  assert.deepEqual(olQuery?.lang, [...lang], 'OL sees lang (on the pg-miss → OL fallback path it is only called when GB is empty)');
  assert.deepEqual(gbQuery?.lang, [...lang], 'GB sees lang');
});