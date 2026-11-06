import type { Contributor } from './book-wire';
import { rowIdentifiers } from './edition-record';

/**
 * Lexicon-shaped record values for the `community.lexicon.book.*` collections
 * this AppView serves from Postgres.
 *
 * There is exactly one builder per collection: the value a record is served
 * with is the value its CID is computed from, so a second copy of the shape
 * would silently drift from the served bytes. Editions live in
 * `edition-record.ts`; the rest are here.
 *
 * The `*RecordSource` types are what each value reads, which both a stored row
 * and an ingested item satisfy — ingest and the backfills therefore hash the
 * same bytes the response boundary serves.
 */

/** Fields a work record value reads. */
export interface WorkRecordSource {
	uri: string;
	title: string;
	createdAt: Date | string;
	subtitle?: string | null;
	originalLanguage?: string | null;
	firstPublishedYear?: number | null;
	subjects?: readonly string[] | null;
	identifiers?: unknown;
	description?: string | null;
}

/** Fields a contributor record value reads. */
export interface ContributorRecordSource {
	uri: string;
	name: string;
	createdAt: Date | string;
	aliases?: readonly string[] | null;
	bio?: string | null;
	bornYear?: number | null;
	diedYear?: number | null;
	linkedDid?: string | null;
	identifiers?: unknown;
}

/** Fields a publisher record value reads. */
export interface PublisherRecordSource {
	uri: string;
	name: string;
	createdAt: Date | string;
	imprintOfUri?: string | null;
	imprintOfCid?: string | null;
	foundingDate?: number | null;
	closingDate?: number | null;
	identifiers?: unknown;
}

function createdAtString(createdAt: Date | string): string {
	return typeof createdAt === 'string' ? createdAt : createdAt.toISOString();
}

/** `community.lexicon.book.work` record value. */
export function workRecordValue(
	row: WorkRecordSource,
	contributors: Contributor[],
	overrides: { description?: string | null } = {},
): Record<string, unknown> {
	const description = overrides.description === undefined ? row.description : overrides.description;
	return {
		$type: 'community.lexicon.book.work' as const,
		uri: row.uri,
		title: row.title,
		subtitle: row.subtitle ?? undefined,
		originalLanguage: row.originalLanguage ?? undefined,
		firstPublishedYear: row.firstPublishedYear ?? undefined,
		subjects: row.subjects ?? [],
		contributors,
		identifiers: rowIdentifiers(row.identifiers),
		description: description ?? undefined,
		createdAt: createdAtString(row.createdAt),
	};
}

/** `community.lexicon.book.contributor` record value. */
export function contributorRecordValue(row: ContributorRecordSource): Record<string, unknown> {
	return {
		$type: 'community.lexicon.book.contributor' as const,
		uri: row.uri,
		name: row.name,
		aliases: row.aliases ?? [],
		bio: row.bio ?? undefined,
		bornYear: row.bornYear ?? undefined,
		diedYear: row.diedYear ?? undefined,
		linkedDid: row.linkedDid ?? undefined,
		identifiers: rowIdentifiers(row.identifiers),
		createdAt: createdAtString(row.createdAt),
	};
}

/** `community.lexicon.book.publisher` record value. */
export function publisherRecordValue(row: PublisherRecordSource): Record<string, unknown> {
	return {
		$type: 'community.lexicon.book.publisher' as const,
		uri: row.uri,
		name: row.name,
		imprintOf:
			row.imprintOfUri && row.imprintOfCid
				? { uri: row.imprintOfUri, cid: row.imprintOfCid }
				: undefined,
		foundingDate: row.foundingDate ?? undefined,
		closingDate: row.closingDate ?? undefined,
		identifiers: rowIdentifiers(row.identifiers),
		createdAt: createdAtString(row.createdAt),
	};
}
