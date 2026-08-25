import type { Logger } from 'pino';
import * as googleBooks from '../api/google-books';
import type { SearchQuery, SearchResult, EditionItem, WorkItem } from './types';

export class GoogleBooksSource {
  constructor(private readonly log: Logger) {}

  searchEditions(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<EditionItem>> {
    return googleBooks.searchEditions(query, this.log, signal);
  }

  searchWorks(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<WorkItem>> {
    return googleBooks.searchWorks(query, this.log, signal);
  }
}