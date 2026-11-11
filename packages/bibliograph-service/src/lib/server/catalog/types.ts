import type { Identifier } from '../identifiers';

/** One credited contributor, in record order. */
export interface ContributorInput {
	name: string;
	role?: string;
	identifiers?: Identifier[];
	/** Optional enrichment reference (an AT-URI of any record type). */
	ref?: string;
}

/** `community.lexicon.media.book.defs#series`. */
export interface SeriesValue {
	name: string;
	position?: string;
	display?: string;
}

/** The organization that published the edition. */
export interface PublisherInput {
	name: string;
	identifiers?: Identifier[];
}

/**
 * Provider-shaped edition metadata. This is the input to catalog ingestion and
 * the shape admin imports produce; it is deliberately not the wire shape (the
 * record value is built by `editionRecordValue`).
 */
export interface EditionInput {
	title: string;
	subtitle?: string | null;
	language?: string | null;
	publishedDate?: string | null;
	format?: string | null;
	pages?: number | null;
	durationSeconds?: number | null;
	chapters?: number | null;
	series?: SeriesValue | null;
	bookEdition?: string | null;
	description?: string | null;
	coverUrl?: string | null;
	identifiers: Identifier[];
	contributors: ContributorInput[];
	publisher?: PublisherInput | null;
	createdAt: string;
}

/** A row of the `appview_book` view. */
export interface AppviewBookRow {
	uri: string;
	rkey: string;
	title: string;
	subtitle: string | null;
	language: string | null;
	published_date: string | null;
	format: string | null;
	pages: number | null;
	duration_seconds: number | null;
	chapters: number | null;
	series: SeriesValue | null;

	book_edition: string | null;
	description: string | null;
	cover_url: string | null;
	created_at: string | Date;
	contributors: Array<{
		position: number;
		name: string;
		role: string;
		identifiers: Identifier[];
		ref: string | null;
	}>;
	publisher: { name: string; identifiers: Identifier[] } | null;
	publishers: Array<{ name: string; identifiers: Identifier[] }>;
	identifiers: Identifier[];
}
