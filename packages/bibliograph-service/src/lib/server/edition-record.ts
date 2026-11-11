import { sql } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import type { Identifier } from './identifiers';
import { formatToWire, usableCoverUrl } from './media-book-view';
import type { AppviewBookRow, SeriesValue } from './catalog/types';
import { db } from './db';

/**
 * The lexicon-shaped `community.lexicon.media.book.edition` record value.
 *
 * This is the ONLY place the edition record shape is written: the CID clients
 * receive is the CID of the record as the API serves it, so the outbox
 * publisher builds every write from here. Identifiers and contributors are
 * entity rows; this function is where they are inlined onto the wire.
 */

export interface EditionRecordOptions {
	/** The edition AT-URI, used only for error context; not part of the value. */
	uri?: string;
}

/**
 * Build the record value from an `appview_book` row. Returns `null` when the
 * edition carries no identifiers: the lexicon requires at least one, so there
 * is no valid record to hash and the caller must skip the write.
 */
export function editionRecordValue(row: AppviewBookRow, _opts: EditionRecordOptions = {}): Record<string, unknown> | null {
	const identifiers = Array.isArray(row.identifiers) ? row.identifiers : [];
	if (identifiers.length === 0) return null;

	const value: Record<string, unknown> = {
		$type: 'community.lexicon.media.book.edition',
		title: row.title,
		identifiers: identifiers.map((identifier) => ({ issuer: identifier.issuer, value: identifier.value })),
		contributors: (Array.isArray(row.contributors) ? row.contributors : []).map((entry) => {
			const contributor: Record<string, unknown> = {
				name: entry.name,
				role: entry.role || 'author',
			};
			if (entry.identifiers?.length) contributor.identifiers = entry.identifiers;
			if (entry.ref) contributor.ref = entry.ref;
			return contributor;
		}),
		createdAt: new Date(row.created_at).toISOString(),
	};
	if (row.subtitle) value.subtitle = row.subtitle;
	if (row.language) value.language = row.language;
	if (row.published_date) value.publishedDate = row.published_date;
	const format = formatToWire(row.format);
	if (format) value.format = format;
	if (row.pages !== null && row.pages !== undefined) value.pages = row.pages;
	if (row.duration_seconds !== null && row.duration_seconds !== undefined) value.durationSeconds = row.duration_seconds;
	if (row.chapters !== null && row.chapters !== undefined) value.chapters = row.chapters;
	if (row.series) value.series = row.series;
	if (row.book_edition) value.bookEdition = row.book_edition;
	if (row.description) value.description = row.description;
	const coverUrl = usableCoverUrl(row.cover_url);
	if (coverUrl) value.coverUrl = coverUrl;
	if (row.publisher) {
		const publisher: Record<string, unknown> = { name: row.publisher.name };
		if (row.publisher.identifiers?.length) publisher.identifiers = row.publisher.identifiers;
		value.publisher = publisher;
	}
	return value;
}

/** {@link editionRecordValue}'s CID, or `null` when there is no valid value. */
export async function editionRecordCid(row: AppviewBookRow): Promise<string | null> {
	const value = editionRecordValue(row);
	if (!value) return null;
	return (await cidForLex(value as unknown as LexMap)).toString();
}

/** Build a record from an explicit children shape (imports before a row exists). */
export function editionRecordFromParts(parts: {
	title: string;
	identifiers: Identifier[];
	contributors: Array<{ name: string; role?: string; identifiers?: Identifier[]; ref?: string }>;
	publisher?: { name: string; identifiers?: Identifier[] } | null;
	createdAt: string | Date;
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
}): Record<string, unknown> | null {
	if (parts.identifiers.length === 0) return null;
	const value: Record<string, unknown> = {
		$type: 'community.lexicon.media.book.edition',
		title: parts.title,
		identifiers: parts.identifiers,
		contributors: parts.contributors.map((contributor) => {
			const entry: Record<string, unknown> = { name: contributor.name, role: contributor.role ?? 'author' };
			if (contributor.identifiers?.length) entry.identifiers = contributor.identifiers;
			if (contributor.ref) entry.ref = contributor.ref;
			return entry;
		}),
		createdAt: parts.createdAt instanceof Date ? parts.createdAt.toISOString() : parts.createdAt,
	};
	if (parts.subtitle) value.subtitle = parts.subtitle;
	if (parts.language) value.language = parts.language;
	if (parts.publishedDate) value.publishedDate = parts.publishedDate;
	const format = formatToWire(parts.format);
	if (format) value.format = format;
	if (parts.pages !== null && parts.pages !== undefined) value.pages = parts.pages;
	if (parts.durationSeconds !== null && parts.durationSeconds !== undefined) value.durationSeconds = parts.durationSeconds;
	if (parts.chapters !== null && parts.chapters !== undefined) value.chapters = parts.chapters;
	if (parts.series) value.series = parts.series;
	if (parts.bookEdition) value.bookEdition = parts.bookEdition;
	if (parts.description) value.description = parts.description;
	const coverUrl = usableCoverUrl(parts.coverUrl);
	if (coverUrl) value.coverUrl = coverUrl;
	if (parts.publisher) {
		const publisher: Record<string, unknown> = { name: parts.publisher.name };
		if (parts.publisher.identifiers?.length) publisher.identifiers = parts.publisher.identifiers;
		value.publisher = publisher;
	}
	return value;
}

/** The edition's identifier rows, in canonical `(issuer, value)` order. */
export async function loadEditionIdentifiers(uri: string): Promise<Identifier[]> {
	const rows = (await db.execute(sql`
		SELECT issuer, value FROM edition_identifiers WHERE edition_uri = ${uri} ORDER BY issuer, value
	`)) as unknown as { rows?: Array<{ issuer: string; value: string }> };
	return (rows.rows ?? []).map((row) => ({ issuer: row.issuer, value: row.value }));
}
