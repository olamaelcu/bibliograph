import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db as defaultDb } from '../db/index';
import { editionGoodreadsBackfill, editions, type EditionRow } from '../db/schema';
import { loadEditionIdentifiers } from '../edition-record';
import {
	identifierKey,
	isbnValueFromIdentifier,
	providerIdentifier,
	sameIdentifier,
	type Identifier,
} from '../identifiers';
import { MAX_IDENTIFIERS, mergeIsbnIdentifiers } from '../isbn/merge';
import { GoodreadsBlockedError, fetchGoodreadsBook } from '../api/goodreads';

type Db = typeof defaultDb;

export type FormatBackfillStatus =
	| 'updated'
	| 'no_isbn'
	| 'already_complete'
	| 'not_found'
	| 'blocked'
	| 'no_change'
	| 'not_found'
	| 'dry_run';

export interface FormatBackfillResult {
	status: FormatBackfillStatus;
}

const LANGUAGE_TAGS: Record<string, string> = {
	english: 'en',
	german: 'de',
	french: 'fr',
	spanish: 'es',
	italian: 'it',
	portuguese: 'pt',
	dutch: 'nl',
	swedish: 'sv',
	norwegian: 'no',
	danish: 'da',
	finnish: 'fi',
	polish: 'pl',
	russian: 'ru',
	japanese: 'ja',
	chinese: 'zh',
	korean: 'ko',
	arabic: 'ar',
	hebrew: 'he',
	turkish: 'tr',
	czech: 'cs',
	greek: 'el',
	hungarian: 'hu',
	romanian: 'ro',
	ukrainian: 'uk',
};

function languageTag(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const value = raw.trim();
	if (/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(value)) return value;
	return LANGUAGE_TAGS[value.toLowerCase()];
}

function publishYear(publishedDate: string | null): number | null {
	const match = /^(\d{4})/.exec(publishedDate ?? '');
	return match ? Number(match[1]) : null;
}

/** The ISBN a row carries, as the hyphenless ISBN-13 the record stores. */
export function isbnForRow(identifiers: readonly Identifier[]): string | undefined {
	for (const identifier of identifiers) {
		const isbn = isbnValueFromIdentifier(identifier);
		if (isbn) return isbn;
	}
	return undefined;
}

function appendIdentifier(identifiers: readonly Identifier[], identifier: Identifier): Identifier[] {
	if (identifiers.length >= MAX_IDENTIFIERS || identifiers.some((current) => sameIdentifier(current, identifier))) {
		return [...identifiers];
	}
	return [...identifiers, identifier];
}

function identifiersChanged(before: readonly Identifier[], after: readonly Identifier[]): boolean {
	return (
		before.length !== after.length ||
		before.some((identifier, index) => {
			const next = after[index];
			return !next || identifierKey(identifier) !== identifierKey(next);
		})
	);
}

/** Write the identifier set, replacing rows the merge removed and adding new ones. */
async function writeIdentifiers(db: Db, uri: string, identifiers: readonly Identifier[]): Promise<void> {
	if (identifiers.length === 0) {
		await db.execute(sql`DELETE FROM edition_identifiers WHERE edition_uri = ${uri}`);
		return;
	}
	const pairs = sql.join(
		identifiers.map((identifier) => sql`(${identifier.issuer}::text, ${identifier.value}::text)`),
		sql`, `,
	);
	await db.execute(sql`
		DELETE FROM edition_identifiers
		WHERE edition_uri = ${uri} AND (issuer, value) NOT IN (${pairs})
	`);
	for (const identifier of identifiers) {
		await db.execute(sql`
			INSERT INTO edition_identifiers (edition_uri, issuer, value)
			VALUES (${uri}, ${identifier.issuer}, ${identifier.value})
			ON CONFLICT DO NOTHING
		`);
	}
}

/** Task entrypoint: load the row and run the metadata backfill. */
export async function backfillFormatForEdition(
	uri: string,
	log: Logger,
	db: Db = defaultDb,
): Promise<FormatBackfillResult> {
	const rows = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
	const row = rows[0];
	if (!row) return { status: 'not_found' };
	return backfillEditionMetadata(row, log, { db });
}

/**
 * Backfill `format`, `pages`, the publication year, `language` and
 * provider identifiers on one edition from Goodreads.
 *
 * Only missing fields are written; an explicit admin click re-contacts
 * Goodreads even for rows recorded as `not_found`.
 */
export async function backfillEditionMetadata(
	row: EditionRow,
	log: Logger,
	opts?: { dry?: boolean; db?: Db },
): Promise<FormatBackfillResult> {
	const db = opts?.db ?? defaultDb;
	const STAGE = 'backfill-formats';
	const currentIdentifiers = await loadEditionIdentifiers(row.uri);
	const rowIsbn = isbnForRow(currentIdentifiers);
	if (!rowIsbn) {
		log.info({ stage: STAGE, uri: row.uri, reason: 'no_isbn' }, 'no ISBN on row; nothing to look up');
		return { status: 'no_isbn' };
	}
	const rowYear = publishYear(row.publishedDate);
	if (row.format != null && row.pages != null && rowYear != null && row.language != null) {
		log.info({ stage: STAGE, uri: row.uri, reason: 'already_complete' }, 'edition metadata complete; nothing to do');
		return { status: 'already_complete' };
	}

	let found;
	try {
		found = await fetchGoodreadsBook(rowIsbn);
	} catch (err) {
		if (err instanceof GoodreadsBlockedError) {
			log.error(
				{ event: 'goodreads-blocked', stage: STAGE, uri: row.uri, isbn: rowIsbn, status: err.status },
				'goodreads blocked the backfill',
			);
			return { status: 'blocked' };
		}
		throw err;
	}

	if (!found) {
		log.warn({ event: 'goodreads-book-not-found', stage: STAGE, uri: row.uri, isbn: rowIsbn }, 'goodreads book not found');
		await db
			.insert(editionGoodreadsBackfill)
			.values({ uri: row.uri, status: 'not_found', reason: 'not_found', checkedAt: new Date() })
			.onConflictDoUpdate({
				target: editionGoodreadsBackfill.uri,
				set: { status: 'not_found', reason: 'not_found', checkedAt: new Date() },
			});
		return { status: 'not_found' };
	}

	const isbnMerge = mergeIsbnIdentifiers(
		currentIdentifiers,
		[found.isbn10, found.isbn13].filter((value): value is string => value !== undefined),
	);
	let nextIdentifiers = isbnMerge.identifiers;
	if (found.asin) nextIdentifiers = appendIdentifier(nextIdentifiers, { issuer: 'asin', value: found.asin });
	nextIdentifiers = appendIdentifier(nextIdentifiers, providerIdentifier('goodreads', found.url));

	const nextFormat = row.format ?? found.format ?? null;
	const nextPages = row.pages ?? found.pages ?? null;
	const nextYear = rowYear ?? found.publishedYear ?? null;
	const nextLanguage = row.language ?? languageTag(found.language) ?? null;
	const identifiersMoved = identifiersChanged(currentIdentifiers, nextIdentifiers);
	const changed =
		(row.format === null && nextFormat != null) ||
		(row.pages === null && nextPages != null) ||
		(row.publishedDate === null && nextYear != null) ||
		(row.language === null && nextLanguage != null) ||
		identifiersMoved;

	if (!changed) {
		log.info({ stage: STAGE, uri: row.uri, isbn: rowIsbn, reason: 'already_have_fields' }, 'nothing to write');
		return { status: 'no_change' };
	}

	if (opts?.dry) {
		log.info(
			{
				stage: STAGE,
				uri: row.uri,
				isbn: rowIsbn,
				format: nextFormat,
				pages: nextPages,
				publishedYear: nextYear,
				language: nextLanguage,
				identifiers: nextIdentifiers,
				publisher: found.publisher,
				publishedDate: found.publishedDate,
				genres: found.genres.map((genre) => genre.name),
				contributors: found.contributors,
				source: found.url,
			},
			'dry-run: would update',
		);
		return { status: 'dry_run' };
	}

	await db
		.update(editions)
		.set({
			format: nextFormat,
			pages: nextPages,
			publishedDate: nextYear === null ? row.publishedDate : String(nextYear),
			language: nextLanguage,
			indexedAt: new Date(),
		})
		.where(eq(editions.uri, row.uri));

	if (identifiersMoved) await writeIdentifiers(db, row.uri, nextIdentifiers);

	await db
		.insert(editionGoodreadsBackfill)
		.values({ uri: row.uri, status: 'updated', checkedAt: new Date() })
		.onConflictDoUpdate({
			target: editionGoodreadsBackfill.uri,
			set: { status: 'updated', reason: null, checkedAt: new Date() },
		});

	log.info(
		{
			stage: STAGE,
			uri: row.uri,
			isbn: rowIsbn,
			format: nextFormat,
			pages: nextPages,
			publishedYear: nextYear,
			language: nextLanguage,
			identifiers: nextIdentifiers,
			publisher: found.publisher,
			publishedDate: found.publishedDate,
			genres: found.genres.map((genre) => genre.name),
			contributors: found.contributors,
			source: found.url,
		},
		'edition metadata backfilled',
	);
	return { status: 'updated' };
}
