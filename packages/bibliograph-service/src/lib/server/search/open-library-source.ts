import type { Logger } from 'pino';
import * as openLibrary from '../api/open-library.ts';
import type { SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem } from './types.ts';

export class OpenLibrarySource {
  constructor(private readonly log: Logger) {}

  searchEditions(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<EditionItem>> {
    return openLibrary.searchEditions(query, this.log, signal);
  }
  searchWorks(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<WorkItem>> {
    return openLibrary.searchWorks(query, this.log, signal);
  }
  searchContributors(query: SearchQuery, signal?: AbortSignal): Promise<SearchResult<ContributorItem>> {
    return openLibrary.searchContributors(query, this.log, signal);
  }
}
