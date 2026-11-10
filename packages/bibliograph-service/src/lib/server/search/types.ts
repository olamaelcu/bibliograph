import type { Logger } from 'pino';

export type { Identifier } from '../identifiers';

import type { Identifier } from '../identifiers';

export interface ContributionEntry {
  subject: { uri: string; cid: string };
  role: string;
}

export interface EditionItem {
  uri: string;
  title: string;
  subtitle?: string;
  publishedYear?: number;
  place?: string;
  language?: string;
  description?: string;
  coverImageUrl?: string;
  format?: string;
  pages?: number;
  identifiers: Identifier[];
  contributors: ContributionEntry[];
  createdAt: string;
}

export interface WorkItem {
  uri: string;
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
  uri: string;
  name: string;
  aliases: string[];
  bio?: string;
  bornYear?: number;
  diedYear?: number;
  linkedDid?: string;
  /**
   * Cached portrait URL resolved by the contributor-image backfill. Lives on
   * the local `contributors` row only — it is not part of the
   * `community.lexicon.book.contributor` record, so remote/OL results never
   * carry it.
   */
  imageUrl?: string;
  identifiers: Identifier[];
  createdAt: string;
}

export interface PublisherItem {
  uri: string;
  name: string;
  imprintOf?: { uri: string; cid: string };
  foundingDate?: number;
  closingDate?: number;
  identifiers: Identifier[];
  createdAt: string;
}

export type Item = EditionItem | WorkItem | ContributorItem | PublisherItem;

export interface SearchQuery {
  q?: string;
  /**
   * Structured identifier hints. Search matching is provider-defined, so the
   * canonical `{ type, value }` pairs are passed through unchanged.
   */
  identifiers?: Identifier[];
  id?: string[];
  /** Title relevance hint, only consulted by sources that support it. */
  title?: string;
  /** Author relevance hint, only consulted by sources that support it. */
  author?: string;
  limit: number;
  cursor?: string;
  /**
   * Rows to skip. `community.lexicon.book.searchEditions` paginates by
   * offset, which is what the procedures expose; `cursor` stays for the
   * still-query-shaped contributor/publisher/work searches.
   */
  offset?: number;
  /**
   * BCP-47 language tags to filter results to. Editions whose
   * `language` (or `originalLanguage` for works) doesn't match any tag
   * (or its normalized 2-letter / 3-letter variant) are excluded.
   * Empty / omitted = no language filter.
   */
  lang?: string[];
}

export interface SearchResult<T> {
  items: T[];
  cursor?: string;
  /**
   * Total matches for the query, when the source could produce one cheaply.
   * Absent on continuation pages (`offset > 0` or a cursor), where recomputing
   * it would re-run an unindexable `count(*)` over every match to restate a
   * number the caller already has.
   */
  total?: number;
  /**
   * Whether at least one more page exists. Sources that page by cursor set this
   * from the cursor; Postgres sets it from a `limit + 1` fetch.
   */
  hasMore?: boolean;
  /**
   * Set when an upstream call failed but partial data is still being returned.
   * Lets the XRPC handler decide between 502 UpstreamUnavailable (total miss)
   * and including the field in the body (degraded partial response).
   */
  degraded?: { upstream: 'googlebooks' | 'wikipedia' | 'isbndb' | 'goodreads'; reason: string };
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
