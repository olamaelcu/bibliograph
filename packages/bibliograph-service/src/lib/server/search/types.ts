import type { Logger } from 'pino';

export interface Identifier {
  uri: string;
  resource: string;
}

export interface ContributionEntry {
  subject: { uri: string; cid: string };
  role: string;
}

export interface EditionItem {
  uri?: string;
  title: string;
  subtitle?: string;
  publishedYear?: number;
  place?: string;
  language?: string;
  description?: string;
  coverImageUrl?: string;
  identifiers: Identifier[];
  contributors: ContributionEntry[];
  createdAt: string;
}

export interface WorkItem {
  uri?: string;
  title: string;
  subtitle?: string;
  originalLanguage?: string;
  firstPublishedYear?: number;
  subjects: string[];
  description?: string;
  contributors: ContributionEntry[];
  identifiers: Identifier[];
  createdAt: string;
}

export interface ContributorItem {
  uri?: string;
  name: string;
  aliases: string[];
  bio?: string;
  bornYear?: number;
  diedYear?: number;
  linkedDid?: string;
  identifiers: Identifier[];
  createdAt: string;
}

export type Item = EditionItem | WorkItem | ContributorItem;

export interface SearchQuery {
  q?: string;
  id?: string[];
  limit: number;
  cursor?: string;
}

export interface SearchResult<T> {
  items: T[];
  cursor?: string;
  total?: number;
}

export interface SearchSource<T> {
  readonly name: string;
  search(query: SearchQuery, log: Logger, signal?: AbortSignal): Promise<SearchResult<T>>;
}

export interface Enricher<T> {
  readonly name: string;
  enrich(items: T[], log: Logger, signal?: AbortSignal): Promise<T[]>;
}

export interface Ingestor<T> {
  readonly name: string;
  ingest(items: T[]): Promise<void>;
}
