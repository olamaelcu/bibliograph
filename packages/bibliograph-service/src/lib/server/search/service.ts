import type { Logger } from 'pino';
import { getCorrelationLog } from '../correlation';
import { PostgresSource } from './postgres-source';
import { OpenLibrarySource } from './open-library-source';
import { GoogleBooksEnricher } from './google-books-enricher';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './wikipedia-enricher';
import { enqueueIngest } from '../jobs/enqueue';
import type { SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem } from './types';

export interface SearchServiceDeps {
  postgres: PostgresSource;
  openLibrary: OpenLibrarySource;
  googleBooks: GoogleBooksEnricher;
  authorWikipedia: AuthorWikipediaEnricher;
  contributorWikipedia: ContributorWikipediaEnricher;
}

export class SearchService {
  /** Fallback logger when no correlation context is set (e.g. in tests). */
  private readonly fallbackLog: Logger;
  constructor(private readonly deps: SearchServiceDeps, fallbackLog: Logger) {
    this.fallbackLog = fallbackLog;
  }

  private log(): Logger {
    return getCorrelationLog() ?? this.fallbackLog;
  }

  async searchEditions(query: SearchQuery): Promise<SearchResult<EditionItem>> {
    const log = this.log();
    const pg = await this.deps.postgres.searchEditions(query);
    if (pg.items.length > 0) return pg;
    const ol = await this.deps.openLibrary.searchEditions(query);
    if (ol.items.length === 0) return ol;
    let items = await this.deps.googleBooks.enrich(ol.items, log);
    items = await this.deps.authorWikipedia.enrich(items, log);
    for (const item of items) {
      await enqueueIngest('edition', item);
    }
    log.info({ stage: 'search-editions', items: items.length, total: ol.total }, 'search done');
    return { items, cursor: ol.cursor, total: ol.total };
  }

  async searchWorks(query: SearchQuery): Promise<SearchResult<WorkItem>> {
    const log = this.log();
    const pg = await this.deps.postgres.searchWorks(query);
    if (pg.items.length > 0) return pg;
    const ol = await this.deps.openLibrary.searchWorks(query);
    if (ol.items.length === 0) return ol;
    let items = (await this.deps.authorWikipedia.enrich(ol.items, log)) as WorkItem[];
    for (const item of items) {
      await enqueueIngest('work', item);
    }
    log.info({ stage: 'search-works', items: items.length, total: ol.total }, 'search done');
    return { items, cursor: ol.cursor, total: ol.total };
  }

  async searchContributors(query: SearchQuery): Promise<SearchResult<ContributorItem>> {
    const log = this.log();
    if (!query.q && query.id && query.id.length > 0) {
      return this.deps.postgres.searchContributors(query);
    }
    const pg = await this.deps.postgres.searchContributors(query);
    if (pg.items.length > 0) return pg;
    const ol = await this.deps.openLibrary.searchContributors(query);
    if (ol.items.length === 0) return ol;
    let items = await this.deps.contributorWikipedia.enrich(ol.items, log);
    for (const item of items) {
      await enqueueIngest('contributor', item);
    }
    log.info({ stage: 'search-contributors', items: items.length, total: ol.total }, 'search done');
    return { items, cursor: ol.cursor, total: ol.total };
  }
}