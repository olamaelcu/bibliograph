import type { Logger } from 'pino';
import * as wikipedia from '../api/wikipedia.ts';
import type { ContributorItem, EditionItem, WorkItem, Enricher } from './types.ts';

export class ContributorWikipediaEnricher implements Enricher<ContributorItem> {
  readonly name = 'wikipedia-enricher-contributor';
  enrich(items: ContributorItem[], log: Logger, signal?: AbortSignal): Promise<ContributorItem[]> {
    return wikipedia.enrichContributorBios(items, log, signal);
  }
}

export class AuthorWikipediaEnricher implements Enricher<EditionItem | WorkItem> {
  readonly name = 'wikipedia-enricher-author';
  enrich(items: Array<EditionItem | WorkItem>, log: Logger, signal?: AbortSignal): Promise<Array<EditionItem | WorkItem>> {
    return wikipedia.enrichAuthorsOnWorksOrEditions(items, log, signal);
  }
}