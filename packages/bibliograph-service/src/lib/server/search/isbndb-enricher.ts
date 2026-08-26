import type { Logger } from 'pino';
import * as isbndb from '../api/isbndb';
import type { EditionItem, WorkItem, Enricher } from './types';

export class IsbndbEnricher implements Enricher<EditionItem> {
  readonly name = 'isbndb-enricher';
  enrich(items: EditionItem[], log: Logger, signal?: AbortSignal): Promise<EditionItem[]> {
    return isbndb.enrichEditions(items, log, signal);
  }
}

export class IsbndbWorkEnricher implements Enricher<WorkItem> {
  readonly name = 'isbndb-work-enricher';
  enrich(items: WorkItem[], log: Logger, signal?: AbortSignal): Promise<WorkItem[]> {
    return isbndb.enrichWorks(items, log, signal);
  }
}
