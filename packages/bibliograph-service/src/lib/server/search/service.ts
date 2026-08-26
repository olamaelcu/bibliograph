import type { Logger } from 'pino';
import { getCorrelationLog } from '../correlation';
import { PostgresSource } from './postgres-source';
import { OpenLibrarySource } from './open-library-source';
import { GoogleBooksSource } from './google-books-source';
import { GoogleBooksEnricher } from './google-books-enricher';
import { OpenLibraryEnricher } from './open-library-enricher';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './wikipedia-enricher';
import * as openLibraryApi from '../api/open-library';
import { syncIngestEditions, syncIngestWorks, syncIngestContributors, syncIngestPublishers } from '../jobs/handlers';
import type { SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem, PublisherItem, Identifier } from './types';

export interface SearchServiceDeps {
  postgres: PostgresSource;
  openLibrary: OpenLibrarySource;
  publisherSource: Pick<typeof openLibraryApi, 'searchPublishers'>;
  googleBooksSource: GoogleBooksSource;
  googleBooks: GoogleBooksEnricher;
  openLibraryEnricher: OpenLibraryEnricher;
  authorWikipedia: AuthorWikipediaEnricher;
  contributorWikipedia: ContributorWikipediaEnricher;
}

export class SearchService {
  private readonly fallbackLog: Logger;
  constructor(private readonly deps: SearchServiceDeps, fallbackLog: Logger) {
    this.fallbackLog = fallbackLog;
  }

  private log(): Logger {
    return getCorrelationLog() ?? this.fallbackLog;
  }

  /**
   * Merge remote (synthesized) items with postgres-cached items by `uri`.
   * Remote wins on title/subtitle/description/cover/place/publishedYear/language/identifiers.
   * Postgres wins on contributors (often resolved upstream) and indexedAt.
   */
  private mergeItems<T extends { uri: string }>(remote: T[], local: T[]): T[] {
    const remoteUris = new Set(remote.map((i) => i.uri));
    const byUri = new Map<string, T>();
    for (const l of local) byUri.set(l.uri, l);
    const merged: T[] = [];
    for (const r of remote) {
      const existing = byUri.get(r.uri);
      merged.push(existing ? ({ ...existing, ...r } as T) : r);
    }
    for (const l of local) if (!remoteUris.has(l.uri)) merged.push(l);
    return merged;
  }

  async searchEditions(query: SearchQuery): Promise<SearchResult<EditionItem>> {
    const log = this.log();

    const [pg, gb] = await Promise.all([
      this.deps.postgres.searchEditions(query),
      this.deps.googleBooksSource.searchEditions(query, AbortSignal.timeout(15_000)),
    ]);

    let remoteItems: EditionItem[] = [];
    let remoteCursor: string | undefined;
    let remoteTotal: number | undefined;
    if (gb.items.length > 0) {
      const enriched = (await this.deps.openLibraryEnricher.enrich(gb.items, log)) as EditionItem[];
      remoteItems = (await this.deps.authorWikipedia.enrich(enriched, log)) as EditionItem[];
      remoteCursor = gb.cursor;
      remoteTotal = gb.total;
    } else {
      const ol = await this.deps.openLibrary.searchEditions(query);
      if (ol.items.length > 0) {
        const enriched = await this.deps.googleBooks.enrich(ol.items, log);
        remoteItems = (await this.deps.authorWikipedia.enrich(enriched, log)) as EditionItem[];
        remoteCursor = ol.cursor;
        remoteTotal = ol.total;
      }
    }

    const merged = this.mergeItems(remoteItems, pg.items);
    const cursor = remoteCursor ?? pg.cursor;
    const total = remoteTotal ?? pg.total ?? 0;
    const degraded = gb.degraded ?? (remoteItems.length === 0 ? (await this.deps.openLibrary.searchEditions(query)).degraded : undefined);

    if (remoteItems.length > 0) {
      try {
        await syncIngestEditions(remoteItems, log);
      } catch (err) {
        log.error({ stage: 'search-editions.sync-ingest', err }, 'sync ingest failed; continuing');
      }
    }

    log.info({
      stage: 'search-editions',
      remoteCount: remoteItems.length,
      localCount: pg.items.length,
      mergedCount: merged.length,
      total,
    }, 'search done');

    return { items: merged, cursor, total, degraded };
  }

  async searchWorks(query: SearchQuery): Promise<SearchResult<WorkItem>> {
    const log = this.log();

    const [pg, gb] = await Promise.all([
      this.deps.postgres.searchWorks(query),
      this.deps.googleBooksSource.searchWorks(query, AbortSignal.timeout(15_000)),
    ]);

    let remoteItems: WorkItem[] = [];
    let remoteCursor: string | undefined;
    let remoteTotal: number | undefined;
    if (gb.items.length > 0) {
      const enriched = (await this.deps.openLibraryEnricher.enrich(gb.items, log)) as WorkItem[];
      remoteItems = (await this.deps.authorWikipedia.enrich(enriched, log)) as WorkItem[];
      remoteCursor = gb.cursor;
      remoteTotal = gb.total;
    } else {
      const ol = await this.deps.openLibrary.searchWorks(query);
      if (ol.items.length > 0) {
        remoteItems = (await this.deps.authorWikipedia.enrich(ol.items, log)) as WorkItem[];
        remoteCursor = ol.cursor;
        remoteTotal = ol.total;
      }
    }

    const merged = this.mergeItems(remoteItems, pg.items);
    const cursor = remoteCursor ?? pg.cursor;
    const total = remoteTotal ?? pg.total ?? 0;
    const degraded = gb.degraded;

    if (remoteItems.length > 0) {
      try {
        await syncIngestWorks(remoteItems, log);
      } catch (err) {
        log.error({ stage: 'search-works.sync-ingest', err }, 'sync ingest failed; continuing');
      }
    }

    log.info({
      stage: 'search-works',
      remoteCount: remoteItems.length,
      localCount: pg.items.length,
      mergedCount: merged.length,
      total,
    }, 'search done');

    return { items: merged, cursor, total, degraded };
  }

  async searchContributors(query: SearchQuery): Promise<SearchResult<ContributorItem>> {
    const log = this.log();

    if (!query.q && query.id && query.id.length > 0) {
      return this.deps.postgres.searchContributors(query);
    }

    const [pg, ol] = await Promise.all([
      this.deps.postgres.searchContributors(query),
      this.deps.openLibrary.searchContributors(query),
    ]);

    let remoteItems: ContributorItem[] = [];
    if (ol.items.length > 0) {
      remoteItems = await this.deps.contributorWikipedia.enrich(ol.items, log);
    }

    const merged = this.mergeItems(remoteItems, pg.items);

    if (remoteItems.length > 0) {
      try {
        await syncIngestContributors(remoteItems, log);
      } catch (err) {
        console.error('SYNC INGEST ERR:', err);
        log.error({ stage: 'search-contributors.sync-ingest', err }, 'sync ingest failed; continuing');
      }
    }

    log.info({
      stage: 'search-contributors',
      remoteCount: remoteItems.length,
      localCount: pg.items.length,
      mergedCount: merged.length,
      total: ol.total || pg.total || 0,
    }, 'search done');

    return { items: merged, cursor: ol.cursor ?? pg.cursor, total: ol.total || pg.total || 0 };
  }

  async searchPublishers(query: SearchQuery): Promise<SearchResult<PublisherItem>> {
    const log = this.log();

    const [pg, ol] = await Promise.all([
      this.deps.postgres.searchPublishers(query),
      this.deps.publisherSource.searchPublishers(query, log).catch((err: unknown) => {
        log.warn({ stage: 'search-publishers', err }, 'OL publisher search failed; postgres only');
        return { items: [] as Array<{ uri: string; name: string; identifiers: Identifier[]; createdAt: string }>, total: 0 };
      }),
    ]);

    const remoteItems = ol.items as PublisherItem[];
    const merged = this.mergeItems(remoteItems, pg.items);

    if (remoteItems.length > 0) {
      try {
        await syncIngestPublishers(remoteItems, log);
      } catch (err) {
        log.error({ stage: 'search-publishers.sync-ingest', err }, 'sync ingest failed; continuing');
      }
    }

    log.info({
      stage: 'search-publishers',
      remoteCount: remoteItems.length,
      localCount: pg.items.length,
      mergedCount: merged.length,
      total: ol.total || pg.total || 0,
    }, 'search done');

    return { items: merged, cursor: undefined, total: ol.total || pg.total || 0 };
  }
}