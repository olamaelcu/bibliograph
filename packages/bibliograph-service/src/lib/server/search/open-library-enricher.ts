import type { Logger } from 'pino';
import * as openLibrary from '../api/open-library';
import type { EditionItem, WorkItem, Enricher } from './types';

export class OpenLibraryEnricher implements Enricher<EditionItem | WorkItem> {
  readonly name = 'open-library-enricher';
  enrich(items: Array<EditionItem | WorkItem>, log: Logger, signal?: AbortSignal): Promise<Array<EditionItem | WorkItem>> {
    if (items.length === 0) return Promise.resolve([]);
    const first = items[0];
    if (first && 'publishedYear' in first) {
      return openLibrary.enrichEditions(items as EditionItem[], log, signal);
    }
    return openLibrary.enrichWorks(items as WorkItem[], log, signal);
  }
}