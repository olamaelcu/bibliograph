import type { Logger } from 'pino';
import type { ContributorInput, PublisherInput, SeriesValue } from '../catalog/types';

export type { Identifier } from '../identifiers';

import type { Identifier } from '../identifiers';

/**
 * Provider-shaped edition metadata. `upsertEdition` turns this into catalog
 * rows; contributor and publisher names are already inlined because the wire
 * record inlines them.
 */
export interface EditionItem {
	title: string;
	subtitle?: string;
	publishedYear?: number;
	place?: string;
	language?: string;
	description?: string;
	coverUrl?: string;
	format?: string;
	pages?: number;
	durationSeconds?: number;
	chapters?: number;
	series?: SeriesValue;
	bookEdition?: string;
	publisher?: PublisherInput | null;
	identifiers: Identifier[];
	contributors: ContributorInput[];
	createdAt: string;
}

export interface SearchQuery {
	q?: string;
	/** Structured identifier hints, compared exactly by `(issuer, value)`. */
	identifiers?: Identifier[];
	id?: string[];
	title?: string;
	author?: string;
	limit: number;
	cursor?: string;
	offset?: number;
	lang?: string[];
}

export interface SearchResult<T> {
	items: T[];
	cursor?: string;
	total?: number;
	hasMore?: boolean;
	degraded?: { upstream: 'googlebooks' | 'wikipedia' | 'isbndb' | 'goodreads'; reason: string };
}

export interface SearchSource<T> {
	readonly name: string;
	search(query: SearchQuery, log: Logger, signal?: AbortSignal): Promise<SearchResult<T>>;
}
