import {
	isbn13FromAny,
	isbnIdentifier as canonicalIsbnIdentifier,
	isbnValueFromIdentifier,
	uniqueIdentifiers,
	type Identifier,
} from '../identifiers';

/**
 * ISBN identifiers on an edition record.
 *
 * `community.lexicon.media.book.defs#identifier` carries an ISBN as
 * `{ issuer: 'isbn13', value: '<hyphenless ISBN-13>' }` and compares identifiers by
 * exact `type`/`value` equality. ISBN-10 is therefore not representable: the
 * lexicon requires conversion to ISBN-13 on write, so an edition holds at most
 * one ISBN identifier. Everything here is append-only — this runs against
 * records other systems may have written.
 */

/** `edition#identifier` caps the array at 32 entries. */
export const MAX_IDENTIFIERS = 32;

/** Digits only, with a trailing `X` kept for ISBN-10. Hyphens and spaces go. */
export function normaliseIsbn(raw: string): string {
	return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

/** The ISBN an identifier carries, or null when it is not a usable one. */
export function isbnFromIdentifier(identifier: Identifier): string | null {
	return isbnValueFromIdentifier(identifier);
}

export function hasIsbn(identifiers: readonly Identifier[] | undefined): boolean {
	return (identifiers ?? []).some((ident) => isbnFromIdentifier(ident) !== null);
}

/** Build the identifier for a raw ISBN, converting ISBN-10 to ISBN-13. */
export function isbnIdentifier(raw: string): Identifier | null {
	return canonicalIsbnIdentifier(raw);
}

/**
 * Append an ISBN identifier to an edition's identifier list.
 *
 * Nothing already present is removed or reordered: this runs against records
 * other systems may have written, so the only safe direction is additive. The
 * result stops at the lexicon's 32-entry cap rather than producing a record the
 * lexicon would reject.
 */
export function mergeIsbnIdentifiers(
	existing: readonly Identifier[],
	candidates: readonly string[],
	max = MAX_IDENTIFIERS,
): { identifiers: Identifier[]; added: string[] } {
	const identifiers = uniqueIdentifiers(existing.map((ident) => ({ ...ident })));
	const seen = new Set(
		identifiers
			.map((ident) => isbnFromIdentifier(ident))
			.filter((value): value is string => value !== null),
	);

	const incoming: Identifier[] = [];
	for (const raw of candidates) {
		const isbn = isbn13FromAny(raw);
		if (!isbn || seen.has(isbn)) continue;
		seen.add(isbn);
		incoming.push({ issuer: 'isbn13', value: isbn });
	}

	const room = Math.max(0, max - identifiers.length);
	const added = incoming.slice(0, room);

	return {
		identifiers: [...identifiers, ...added],
		added: added.map((ident) => ident.value),
	};
}
