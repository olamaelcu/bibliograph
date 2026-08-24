import type { Logger } from 'pino';
import * as googleBooks from '../api/google-books.ts';
import type { EditionItem, Enricher } from './types.ts';

export class GoogleBooksEnricher implements Enricher<EditionItem> {
  readonly name = 'google-books-enricher';
  enrich(items: EditionItem[], log: Logger, signal?: AbortSignal): Promise<EditionItem[]> {
    return googleBooks.enrichEditions(items, log, signal);
  }
}