import type { Logger } from 'pino';
import { getCorrelationLog } from '../correlation';
import { PostgresSource } from './postgres-source';
import { GoogleBooksSource } from './google-books-source';
import { IsbndbSource } from './isbndb-source';
import { GoodreadsSource } from './goodreads-source';
import { GoogleBooksEnricher } from './google-books-enricher';
import { IsbndbEnricher, IsbndbWorkEnricher } from './isbndb-enricher';
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
  wikidataEdition: WikidataEditionEnricher;
}

type ItemLike = { uri: string };

/** The largest of the totals a source actually produced, or undefined if none did. */
function maxDefined(values: ReadonlyArray<number | undefined>): number | undefined {
  let best: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (best === undefined || value > best) best = value;
  }
  return best;
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
      this.deps.googleBooksSource.searchEditions(query),
      this.deps.goodreadsSource?.searchEditions(query) ??
        Promise.resolve({ items: [], total: 0 } as SearchResult<EditionItem>),
    ]);

    const editionEnrichers: ReadonlyArray<Enricher<EditionItem>> = [
      this.deps.googleBooks,
      this.deps.isbndbEnricher,
      this.deps.wikidataEdition,
    ];

    // The Goodreads items and the Google/ISBNdb items are disjoint sets, so the
    // two provider fan-outs enrich in parallel; only the de-duplication below
    // needs both answers.
    const [remote, grEnriched] = await Promise.all([
      this.resolveRemoteEditions(query, gb, log, editionEnrichers),
      gr.items.length > 0
        ? this.runEnrichers(gr.items, editionEnrichers, log)
        : Promise.resolve(gr.items),
    ]);
    const seenTitles = new Set(remote.items.map((item) => this.titleKey(item.title)));
    const grItems = grEnriched.filter((item) => !seenTitles.has(this.titleKey(item.title)));
    const remoteItems = [...remote.items, ...grItems].slice(0, query.limit);
    // The page is `limit` long: merging local rows on top of a full remote page
    // used to return up to twice the requested size while callers paged by
    // `offset += limit`.
    const merged = this.mergeItems(remoteItems, pg.items).slice(0, query.limit);
    const cursor = remote.cursor ?? pg.cursor;
    const total = maxDefined([remote.total, gr.total, pg.total]);
    const hasMore = Boolean(remote.hasMore || gr.hasMore || pg.hasMore);
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
      total: total ?? null,
      hasMore,
      degraded: !!degraded,
    }, 'search done');

    return { items: merged, cursor, total, hasMore, degraded };
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
    const merged = this.mergeItems(remote.items, pg.items).slice(0, query.limit);
    const cursor = remote.cursor ?? pg.cursor;
    const total = maxDefined([remote.total, pg.total]);
    const hasMore = Boolean(remote.hasMore || pg.hasMore);

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
      total: total ?? null,
      hasMore,
      degraded: !!remote.degraded,
    }, 'search done');

    return { items: merged, cursor, total, hasMore, degraded: remote.degraded };
  }

  private async resolveRemoteEditions(
    query: SearchQuery,
    gb: SearchResult<EditionItem>,
    log: Logger,
    enrichers: ReadonlyArray<Enricher<EditionItem>>,
  ): Promise<{ items: EditionItem[]; cursor?: string; total?: number; hasMore?: boolean; source: 'googlebooks' | 'isbndb' | null; degraded?: SearchResult<EditionItem>['degraded'] }> {
    if (gb.items.length > 0) {
      return {
        items: await this.runEnrichers(gb.items, enrichers, log),
        cursor: gb.cursor,
        total: gb.total,
        hasMore: gb.hasMore,
        source: 'googlebooks',
        degraded: gb.degraded,
      };
    }
    let degraded = gb.degraded;

    if (isbnFromQuery(query.q)) {
      const ib = await this.deps.isbndbSource.searchEditions(query);
      degraded = degraded ?? ib.degraded;
      if (ib.items.length > 0) {
        return {
          items: await this.runEnrichers(ib.items, enrichers, log),
          cursor: ib.cursor,
          total: ib.total,
          hasMore: ib.hasMore,
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
  ): Promise<{ items: WorkItem[]; cursor?: string; total?: number; hasMore?: boolean; source: 'googlebooks' | 'isbndb' | null; degraded?: SearchResult<WorkItem>['degraded'] }> {
    if (gb.items.length > 0) {
      return {
        items: await this.runEnrichers(gb.items, enrichers, log),
        cursor: gb.cursor,
        total: gb.total,
        hasMore: gb.hasMore,
        source: 'googlebooks',
        degraded: gb.degraded,
      };
    }
    let degraded = gb.degraded;

    if (isbnFromQuery(query.q)) {
      const ib = await this.deps.isbndbSource.searchWorks(query);
      degraded = degraded ?? ib.degraded;
      if (ib.items.length > 0) {
        return {
          items: await this.runEnrichers(ib.items, enrichers, log),
          cursor: ib.cursor,
          total: ib.total,
          hasMore: ib.hasMore,
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
