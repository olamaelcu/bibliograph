import type { Logger } from 'pino';
import { getCorrelationLog } from '../correlation';
import { PostgresSource } from './postgres-source';
import { GoogleBooksSource } from './google-books-source';
import { IsbndbSource } from './isbndb-source';
import { GoodreadsSource } from './goodreads-source';
import { GoogleBooksEnricher } from './google-books-enricher';
import { IsbndbEnricher, IsbndbWorkEnricher } from './isbndb-enricher';
import { AuthorWikipediaEnricher } from './wikipedia-enricher';
import { WikidataEditionEnricher } from './wikidata-enricher';
import { isbnFromQuery } from '../api/isbndb';
import { syncIngestEditions, syncIngestWorks } from '../jobs/handlers';
import { validContributorName } from './contributor-name';
import type { SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem, PublisherItem, Enricher } from './types';

export interface SearchServiceDeps {
  postgres: PostgresSource;
  googleBooksSource: GoogleBooksSource;
  isbndbSource: IsbndbSource;
  goodreadsSource?: GoodreadsSource;
  googleBooks: GoogleBooksEnricher;
  isbndbEnricher: IsbndbEnricher;
  isbndbWorkEnricher: IsbndbWorkEnricher;
  authorWikipedia: AuthorWikipediaEnricher;
  wikidataEdition: WikidataEditionEnricher;
}

type ItemLike = { uri: string };

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

  private titleKey(title: string): string {
    return title.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private async runEnrichers<T extends ItemLike>(
    items: T[],
    enrichers: ReadonlyArray<Enricher<T>>,
    log: Logger,
  ): Promise<T[]> {
    let current = items;
    for (const e of enrichers) {
      current = await e.enrich(current, log);
    }
    return current;
  }

  async searchEditions(query: SearchQuery): Promise<SearchResult<EditionItem>> {
    const log = this.log();

    const [pg, gb, gr] = await Promise.all([
      this.deps.postgres.searchEditions(query),
      this.deps.googleBooksSource.searchEditions(query, AbortSignal.timeout(15_000)),
      this.deps.goodreadsSource?.searchEditions(query, AbortSignal.timeout(15_000)) ??
        Promise.resolve({ items: [], total: 0 } as SearchResult<EditionItem>),
    ]);

    const editionEnrichers: ReadonlyArray<Enricher<EditionItem>> = [
      this.deps.googleBooks,
      this.deps.isbndbEnricher,
      this.deps.authorWikipedia,
      this.deps.wikidataEdition,
    ];

    const remote = await this.resolveRemoteEditions(query, gb, log, editionEnrichers);
    let grItems = gr.items;
    if (grItems.length > 0) {
      grItems = await this.runEnrichers(grItems, editionEnrichers, log);
      const seenTitles = new Set(remote.items.map((item) => this.titleKey(item.title)));
      grItems = grItems.filter((item) => !seenTitles.has(this.titleKey(item.title)));
    }
    const remoteItems = [...remote.items, ...grItems].slice(0, query.limit);
    const merged = this.mergeItems(remoteItems, pg.items);
    const cursor = remote.cursor ?? pg.cursor;
    const total = Math.max(remote.total ?? 0, gr.total, remoteItems.length, pg.total ?? 0);
    const degraded = remote.degraded ?? gr.degraded;

    if (remoteItems.length > 0) {
      try {
        await syncIngestEditions(remoteItems, log);
      } catch (err) {
        log.error({ stage: 'search-editions.sync-ingest', err }, 'sync ingest failed; continuing');
      }
    }

    log.info({
      stage: 'search-editions',
      remoteCount: remote.items.length,
      goodreadsCount: grItems.length,
      remoteSource: remote.source,
      localCount: pg.items.length,
      mergedCount: merged.length,
      total,
      degraded: !!degraded,
    }, 'search done');

    return { items: merged, cursor, total, degraded };
  }

  async searchWorks(query: SearchQuery): Promise<SearchResult<WorkItem>> {
    const log = this.log();

    const [pg, gb] = await Promise.all([
      this.deps.postgres.searchWorks(query),
      this.deps.googleBooksSource.searchWorks(query, AbortSignal.timeout(15_000)),
    ]);

    const workEnrichers: ReadonlyArray<Enricher<WorkItem>> = [
      this.deps.isbndbWorkEnricher,
      this.deps.wikidataEdition,
    ];

    const remote = await this.resolveRemoteWorks(query, gb, log, workEnrichers);
    const merged = this.mergeItems(remote.items, pg.items);
    const cursor = remote.cursor ?? pg.cursor;
    const total = remote.total ?? pg.total ?? 0;

    if (remote.items.length > 0) {
      try {
        await syncIngestWorks(remote.items, log);
      } catch (err) {
        log.error({ stage: 'search-works.sync-ingest', err }, 'sync ingest failed; continuing');
      }
    }

    log.info({
      stage: 'search-works',
      remoteCount: remote.items.length,
      remoteSource: remote.source,
      localCount: pg.items.length,
      mergedCount: merged.length,
      total,
      degraded: !!remote.degraded,
    }, 'search done');

    return { items: merged, cursor, total, degraded: remote.degraded };
  }

  private async resolveRemoteEditions(
    query: SearchQuery,
    gb: SearchResult<EditionItem>,
    log: Logger,
    enrichers: ReadonlyArray<Enricher<EditionItem>>,
  ): Promise<{ items: EditionItem[]; cursor?: string; total?: number; source: 'googlebooks' | 'isbndb' | null; degraded?: SearchResult<EditionItem>['degraded'] }> {
    if (gb.items.length > 0) {
      return {
        items: await this.runEnrichers(gb.items, enrichers, log),
        cursor: gb.cursor,
        total: gb.total,
        source: 'googlebooks',
        degraded: gb.degraded,
      };
    }
    let degraded = gb.degraded;

    if (isbnFromQuery(query.q)) {
      const ib = await this.deps.isbndbSource.searchEditions(query, AbortSignal.timeout(15_000));
      degraded = degraded ?? ib.degraded;
      if (ib.items.length > 0) {
        return {
          items: await this.runEnrichers(ib.items, enrichers, log),
          cursor: ib.cursor,
          total: ib.total,
          source: 'isbndb',
          degraded,
        };
      }
    }
    return { items: [], source: null, degraded };
  }

  private async resolveRemoteWorks(
    query: SearchQuery,
    gb: SearchResult<WorkItem>,
    log: Logger,
    enrichers: ReadonlyArray<Enricher<WorkItem>>,
  ): Promise<{ items: WorkItem[]; cursor?: string; total?: number; source: 'googlebooks' | 'isbndb' | null; degraded?: SearchResult<WorkItem>['degraded'] }> {
    if (gb.items.length > 0) {
      return {
        items: await this.runEnrichers(gb.items, enrichers, log),
        cursor: gb.cursor,
        total: gb.total,
        source: 'googlebooks',
        degraded: gb.degraded,
      };
    }
    let degraded = gb.degraded;

    if (isbnFromQuery(query.q)) {
      const ib = await this.deps.isbndbSource.searchWorks(query, AbortSignal.timeout(15_000));
      degraded = degraded ?? ib.degraded;
      if (ib.items.length > 0) {
        return {
          items: await this.runEnrichers(ib.items, enrichers, log),
          cursor: ib.cursor,
          total: ib.total,
          source: 'isbndb',
          degraded,
        };
      }
    }
    return { items: [], source: null, degraded };
  }

  async searchContributors(query: SearchQuery): Promise<SearchResult<ContributorItem>> {
    // Contributors have no remote catalog source: the index is the answer.
    const local = await this.deps.postgres.searchContributors(query);
    // An empty/whitespace name violates the lexicon's minLength: 1, so it must
    // never reach the wire.
    const items = local.items.filter((i) => validContributorName(i.name));
    return { items, cursor: local.cursor, total: local.total };
  }

  async searchPublishers(query: SearchQuery): Promise<SearchResult<PublisherItem>> {
    // Publishers have no remote catalog source: the index is the answer.
    const pg = await this.deps.postgres.searchPublishers(query);
    return { items: pg.items, cursor: undefined, total: pg.total ?? 0 };
  }
}
