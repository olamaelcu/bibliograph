import type { Logger } from 'pino';
import * as isbndb from '../api/isbndb';
import type { SearchQuery, SearchResult, EditionItem, WorkItem } from './types';

export class IsbndbSource {
  constructor(private readonly log: Logger) {}

  searchEditions(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<EditionItem>> {
    return isbndb.searchEditions(query, this.log, signal);
  }

  searchWorks(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<WorkItem>> {
    return isbndb.searchWorks(query, this.log, signal);
  }
}
