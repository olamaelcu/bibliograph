import test from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { pino } from 'pino';
import { SearchService } from './service';
import type {
  PostgresSource,
  OpenLibrarySource,
  GoogleBooksEnricher,
  ContributorWikipediaEnricher,
  AuthorWikipediaEnricher,
} from './types';
import type {
  SearchQuery,
  SearchResult,
  EditionItem,
  WorkItem,
  ContributorItem,
} from './types';

const log: Logger = pino({ level: 'silent' });

// Fake strategies
function makeFakePostgres(behaviour: (q: SearchQuery) => SearchResult<EditionItem | WorkItem | ContributorItem>): PostgresSource {
  return {
    name: 'fake-postgres',
    searchEditions: async (q) => behaviour(q) as SearchResult<EditionItem>,
    searchWorks: async (q) => behaviour(q) as SearchResult<WorkItem>,
    searchContributors: async (q) => behaviour(q) as SearchResult<ContributorItem>,
  } as unknown as PostgresSource;
}

function makeFakeOpenLibrary(result: SearchResult<EditionItem | WorkItem | ContributorItem>): OpenLibrarySource {
  return {
    name: 'fake-open-library',
    searchEditions: async () => result as SearchResult<EditionItem>,
    searchWorks: async () => result as SearchResult<WorkItem>,
    searchContributors: async () => result as SearchResult<ContributorItem>,
  } as unknown as OpenLibrarySource;
}

function makeFakeGoogleBooks(behaviour: (items: EditionItem[]) => EditionItem[]): GoogleBooksEnricher {
  return {
    name: 'fake-google-books',
    enrich: async (items) => behaviour(items),
  } as unknown as GoogleBooksEnricher;
}

function makeFakeAuthorWiki(noop: boolean): AuthorWikipediaEnricher {
  return {
    name: 'fake-author-wiki',
    enrich: async (items) => noop ? items : items,
  } as unknown as AuthorWikipediaEnricher;
}

function makeFakeContributorWiki(behaviour: (items: ContributorItem[]) => ContributorItem[]): ContributorWikipediaEnricher {
  return {
    name: 'fake-contributor-wiki',
    enrich: async (items) => behaviour(items),
  } as unknown as ContributorWikipediaEnricher;
}

const baseEdition: EditionItem = {
  title: 'Test',
  identifiers: [{ uri: 'https://openlibrary.org/books/OL1M', resource: 'openlibrary' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

const baseWork: WorkItem = {
  title: 'Test',
  subjects: [],
  identifiers: [{ uri: 'https://openlibrary.org/works/OL1W', resource: 'openlibrary' }],
  contributors: [],
  createdAt: new Date().toISOString(),
};

const baseContributor: ContributorItem = {
  name: 'Jane Doe',
  aliases: [],
  identifiers: [{ uri: 'https://openlibrary.org/authors/OL1A', resource: 'openlibrary' }],
  createdAt: new Date().toISOString(),
};

test('searchEditions: postgres hit short-circuits OL', async () => {
  const olCalls: string[] = [];
  const svc = new SearchService(
    {
      postgres: makeFakePostgres(() => ({ items: [baseEdition], total: 1 })),
      openLibrary: { name: 'fake', searchEditions: async () => { olCalls.push('called'); return { items: [baseEdition] }; }, searchWorks: async () => ({ items: [baseWork] }), searchContributors: async () => ({ items: [baseContributor] }) } as unknown as OpenLibrarySource,
      googleBooks: makeFakeGoogleBooks((i) => i),
      authorWikipedia: makeFakeAuthorWiki(true),
      contributorWikipedia: makeFakeContributorWiki((i) => i),
    },
    log,
  );

  const r = await svc.searchEditions({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(olCalls.length, 0, 'OpenLibrary should not be called when Postgres has results');
});

test('searchEditions: postgres miss → OL → GB → author wiki', async () => {
  const olResult: SearchResult<EditionItem> = { items: [baseEdition], total: 1 };
  let gbEnrichedWith: EditionItem[] = [];
  let authorEnrichedWith: EditionItem[] = [];
  const svc = new SearchService(
    {
      postgres: makeFakePostgres(() => ({ items: [] })),
      openLibrary: makeFakeOpenLibrary(olResult),
      googleBooks: { name: 'fake', enrich: async (items) => { gbEnrichedWith = items; return items; } } as unknown as GoogleBooksEnricher['enrich'] extends infer F ? F : never,
      authorWikipedia: { name: 'fake', enrich: async (items: EditionItem[]) => { authorEnrichedWith = items; return items; } } as unknown as AuthorWikipediaEnricher,
      contributorWikipedia: makeFakeContributorWiki((i) => i),
    },
    log,
  );

  const r = await svc.searchEditions({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]?.title, 'Test');
  assert.equal(gbEnrichedWith.length, 1, 'Google Books enricher should run on OL results');
  assert.equal(authorEnrichedWith.length, 1, 'author Wikipedia enricher should run on GB results');
});

test('searchWorks: postgres miss → OL → author wiki', async () => {
  const olResult: SearchResult<WorkItem> = { items: [baseWork], total: 1 };
  let authorEnrichedWith: WorkItem[] = [];
  const svc = new SearchService(
    {
      postgres: makeFakePostgres(() => ({ items: [] })),
      openLibrary: makeFakeOpenLibrary(olResult),
      googleBooks: makeFakeGoogleBooks((i) => i),
      authorWikipedia: { name: 'fake', enrich: async (items: WorkItem[]) => { authorEnrichedWith = items; return items; } } as unknown as AuthorWikipediaEnricher,
      contributorWikipedia: makeFakeContributorWiki((i) => i),
    },
    log,
  );

  const r = await svc.searchWorks({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(authorEnrichedWith.length, 1);
});

test('searchContributors: id-only skips OL (option B from design)', async () => {
  let olCalled = false;
  const svc = new SearchService(
    {
      postgres: makeFakePostgres(() => ({ items: [baseContributor] })),
      openLibrary: { name: 'fake', searchEditions: async () => ({ items: [] }), searchWorks: async () => ({ items: [] }), searchContributors: async () => { olCalled = true; return { items: [] }; } } as unknown as OpenLibrarySource,
      googleBooks: makeFakeGoogleBooks((i) => i),
      authorWikipedia: makeFakeAuthorWiki(true),
      contributorWikipedia: makeFakeContributorWiki((i) => i),
    },
    log,
  );

  const r = await svc.searchContributors({ id: ['https://openlibrary.org/authors/OL1A'], limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(olCalled, false, 'OL should not be called when id is provided without q');
});

test('searchContributors: postgres miss → OL → contributor wiki', async () => {
  let contribEnrichedWith: ContributorItem[] = [];
  const olResult: SearchResult<ContributorItem> = { items: [baseContributor], total: 1 };
  const svc = new SearchService(
    {
      postgres: makeFakePostgres(() => ({ items: [] })),
      openLibrary: makeFakeOpenLibrary(olResult),
      googleBooks: makeFakeGoogleBooks((i) => i),
      authorWikipedia: makeFakeAuthorWiki(true),
      contributorWikipedia: { name: 'fake', enrich: async (items: ContributorItem[]) => { contribEnrichedWith = items; return items; } } as unknown as ContributorWikipediaEnricher,
    },
    log,
  );

  const r = await svc.searchContributors({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(contribEnrichedWith.length, 1);
});