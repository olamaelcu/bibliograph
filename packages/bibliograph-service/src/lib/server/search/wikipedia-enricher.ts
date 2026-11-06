import type { Logger } from 'pino';
import * as wikipedia from '../api/wikipedia';
import type { EditionItem, WorkItem, Enricher } from './types';

export class AuthorWikipediaEnricher implements Enricher<EditionItem | WorkItem> {
  readonly name = 'wikipedia-enricher-author';
  enrich(items: Array<EditionItem | WorkItem>, log: Logger, signal?: AbortSignal): Promise<Array<EditionItem | WorkItem>> {
    return wikipedia.enrichAuthorsOnWorksOrEditions(items, log, signal);
  }
}