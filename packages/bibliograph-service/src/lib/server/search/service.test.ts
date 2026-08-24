import test from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { pino } from 'pino';
import { SearchService } from './service';
import type { PostgresSource } from './postgres-source';
import type { OpenLibrarySource } from './open-library-source';
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
  uri: 'at://did:web:biblio.livtet.olamaelcu.net/community.lexicon.book.contributor/ol.AOL1A',
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

test('searchEditions: postgres hit short-circuits OL', async () => {
  const emptyOl = makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [], total: 0 });
  const gb = makeFakeGoogleBooks();
  const svc = new SearchService(
    {
      postgres: makeFakePostgres({ items: [baseEdition], total: 1 }),
      openLibrary: emptyOl,
      googleBooks: { enrich: gb.enrich } as GoogleBooksEnricher,
      authorWikipedia: makeFakeAuthorWiki() as unknown as AuthorWikipediaEnricher,
      contributorWikipedia: makeFakeContributorWiki() as unknown as ContributorWikipediaEnricher,
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
      postgres: makeFakePostgres({ items: [], total: 0 }),
      openLibrary: makeFakeOpenLibrary({ items: [baseEdition], total: 1 }, { items: [], total: 0 }, { items: [], total: 0 }),
      googleBooks: { enrich: gb.enrich } as GoogleBooksEnricher,
      authorWikipedia: aw as unknown as AuthorWikipediaEnricher,
      contributorWikipedia: makeFakeContributorWiki() as unknown as ContributorWikipediaEnricher,
    },
    log,
  );

  const r = await svc.searchEditions({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(gb.captures.length, 1, 'Google Books enricher should run on OL results');
  assert.equal(aw.captures.length, 1, 'author Wikipedia enricher should run on GB results');
});

test('searchWorks: postgres miss → OL → author wiki', async () => {
  const aw = makeFakeAuthorWiki();
  const svc = new SearchService(
    {
      postgres: makeFakePostgres({ items: [], total: 0 }),
      openLibrary: makeFakeOpenLibrary({ items: [], total: 0 }, { items: [baseWork], total: 1 }, { items: [], total: 0 }),
      googleBooks: { enrich: makeFakeGoogleBooks().enrich } as GoogleBooksEnricher,
      authorWikipedia: aw as unknown as AuthorWikipediaEnricher,
      contributorWikipedia: makeFakeContributorWiki() as unknown as ContributorWikipediaEnricher,
    },
    log,
  );

  const r = await svc.searchWorks({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(aw.captures.length, 1);
});

test('searchContributors: id-only skips OL (option B from design)', async () => {
  const emptyOl = makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [], total: 0 });
  let olContributorsCalled = false;
  emptyOl.searchContributors = async () => { olContributorsCalled = true; return { items: [], total: 0 }; };
  const svc = new SearchService(
    {
      postgres: makeFakePostgres({ items: [baseContributor], total: 1 }),
      openLibrary: emptyOl,
      googleBooks: { enrich: makeFakeGoogleBooks().enrich } as GoogleBooksEnricher,
      authorWikipedia: makeFakeAuthorWiki() as unknown as AuthorWikipediaEnricher,
      contributorWikipedia: makeFakeContributorWiki() as unknown as ContributorWikipediaEnricher,
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
      postgres: makeFakePostgres({ items: [], total: 0 }),
      openLibrary: makeFakeOpenLibrary({ items: [], total: 0 }, { items: [], total: 0 }, { items: [baseContributor], total: 1 }),
      googleBooks: { enrich: makeFakeGoogleBooks().enrich } as GoogleBooksEnricher,
      authorWikipedia: makeFakeAuthorWiki() as unknown as AuthorWikipediaEnricher,
      contributorWikipedia: cw as unknown as ContributorWikipediaEnricher,
    },
    log,
  );

  const r = await svc.searchContributors({ limit: 10 });
  assert.equal(r.items.length, 1);
  assert.equal(cw.captures.length, 1);
});