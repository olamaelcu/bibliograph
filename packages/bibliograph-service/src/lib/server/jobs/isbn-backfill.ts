import type { Logger } from 'pino';
import { eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index';
import { editionIsbnEnrichment, editions } from '../db/schema';
import type { EditionRow } from '../db/schema';
import { loadEditionIdentifiers } from '../edition-record';
import { getEditionByVolumeId } from '../api/google-books';
import { identifierKey, isbnValueFromIdentifier, type Identifier } from '../identifiers';
import { isIsbndbRkey, isbnFromIsbndbRkey } from '../isbndb/keys';
import { isGbRkey, volumeIdFromGbRkey } from '../gb/keys';
import { isbn13FromAny } from '../identifiers';

type Db = typeof defaultDb;

export interface IsbnBackfillOutcome {
	updated: boolean;
	reason: string;
	added?: string[];
}

/**
 * Fill the ISBN an edition is missing.
 *
 * Tier 1 only: the authority the edition was derived from already knows the
 * ISBN, so a `gb.*` volume is re-read and an `isbndb.*` rkey carries it
 * directly. There is no title-matching tier any more — matching a book by title
 * against provider results needs contributor identity, and contributors are
 * now inline metadata rather than records. Rows with no authority ISBN are
 * stamped `none` so the scan does not re-ask forever.
 */
export async function backfillIsbnForEdition(
	uri: string,
	rkey: string,
	log: Logger,
	db: Db = defaultDb,
): Promise<IsbnBackfillOutcome> {
	const rows = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
	const row: EditionRow | undefined = rows[0];
	if (!row) return { updated: false, reason: 'not_found' };
	if (row.rkey !== rkey) {
		log.warn({ stage: 'isbn-backfill', uri, rkey, rowRkey: row.rkey }, 'rkey mismatch; using row rkey');
	}

	const existing = await loadEditionIdentifiers(uri);
	if (existing.some((identifier) => isbnValueFromIdentifier(identifier) !== null)) {
		return { updated: false, reason: 'already_has_isbn' };
	}

	const candidates: Identifier[] = [];
	if (isIsbndbRkey(row.rkey)) {
		const isbn = isbn13FromAny(isbnFromIsbndbRkey(row.rkey));
		if (isbn) candidates.push({ issuer: 'isbn13', value: isbn });
	} else if (isGbRkey(row.rkey)) {
		try {
			const volume = await getEditionByVolumeId(volumeIdFromGbRkey(row.rkey), log);
			for (const identifier of volume?.identifiers ?? []) {
				if (isbnValueFromIdentifier(identifier) !== null) candidates.push(identifier);
			}
		} catch (err) {
			log.warn({ stage: 'isbn-backfill', err, uri }, 'authority refetch failed; deferring');
			return { updated: false, reason: 'deferred' };
		}
	}

	const seen = new Set(existing.map(identifierKey));
	const additions = candidates.filter((identifier) => !seen.has(identifierKey(identifier)));
	if (additions.length === 0) {
		await recordEnrichment(db, uri, 'none', []);
		return { updated: false, reason: 'none' };
	}

	for (const identifier of additions) {
		await db.execute(sql`
			INSERT INTO edition_identifiers (edition_uri, issuer, value)
			VALUES (${uri}, ${identifier.issuer}, ${identifier.value})
			ON CONFLICT DO NOTHING
		`);
	}
	await recordEnrichment(db, uri, 'found', additions);
	log.info({ stage: 'isbn-backfill', uri, added: additions }, 'isbn backfilled');
	return { updated: true, reason: 'ok', added: additions.map((identifier) => identifier.value) };
}

async function recordEnrichment(
	db: Db,
	uri: string,
	result: 'found' | 'none',
	candidates: Identifier[],
): Promise<void> {
	const values = {
		uri,
		checkedAt: new Date(),
		result,
		candidates: candidates.map((identifier) => ({ source: identifier.issuer, isbn: identifier.value, score: 1, accepted: true })),
	};
	await db
		.insert(editionIsbnEnrichment)
		.values(values)
		.onConflictDoUpdate({ target: editionIsbnEnrichment.uri, set: values });
}
