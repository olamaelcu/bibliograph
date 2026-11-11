/**
 * Canonical `community.lexicon.media.book.defs#identifier` helpers.
 *
 * The lexicon compares identifiers by exact `(issuer, value)` equality and never
 * parses or normalises them. That makes the stored form load-bearing: the
 * catalog matches an identifier bag against `edition_identifiers`, which only
 * works if both sides use the same canonical pair. Everything that writes an
 * identifier goes through this module.
 *
 * `issuer` is either a global scheme token (`isbn13`) or the lowercase ASCII
 * domain of the provider that minted the identifier (`googlebooks.com`).
 */

export interface Identifier {
	issuer: string;
	value: string;
	/** Display-only canonical URL; never part of identifier comparison. */
	url?: string;
}

/**
 * Provider resource token → the `issuer` stored for it. The plan pins the
 * issuer map: Google Books volume → googlebooks.com, OpenLibrary →
 * openlibrary.org, ISBNdb → isbndb.com, Goodreads → goodreads.com, ISBN →
 * isbn13.
 */
export const PROVIDER_IDENTIFIER_DOMAINS: Record<string, string> = {
	goodreads: 'goodreads.com',
	googlebooks: 'googlebooks.com',
	'googlebooks-canonical': 'googlebooks.com',
	openlibrary: 'openlibrary.org',
	isbndb: 'isbndb.com',
	wikidata: 'wikidata.org',
	viaf: 'viaf.org',
	isni: 'isni.org',
	imdb: 'imdb.com',
	amazon: 'amazon.com',
	barnes: 'barnesandnoble.com',
	bibliograph: 'biblio.livtet.olamaelcu.net',
	official: 'official',
	web: 'web',
};

/** Digits only, with a trailing `X` kept for ISBN-10. Hyphens and spaces go. */
export function normaliseIsbn(raw: string): string {
	return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

/** ISBN-10 → ISBN-13. The lexicon requires hyphenless ISBN-13 on write. */
export function isbn13FromIsbn10(raw: string): string | null {
	const digits = normaliseIsbn(raw);
	if (digits.length !== 10) return null;
	const body = digits.slice(0, 9);
	if (!/^[0-9]{9}$/.test(body)) return null;
	const stem = `978${body}`;
	let sum = 0;
	for (let i = 0; i < stem.length; i++) {
		sum += Number(stem[i]) * (i % 2 === 0 ? 1 : 3);
	}
	const check = (10 - (sum % 10)) % 10;
	return `${stem}${check}`;
}

/** Normalise any ISBN that can appear on the wire to hyphenless ISBN-13. */
export function isbn13FromAny(raw: string): string | null {
	const digits = normaliseIsbn(raw);
	if (digits.length === 13) return digits;
	if (digits.length === 10) return isbn13FromIsbn10(digits);
	return null;
}

/** Trailing path segment of a URL, ignoring a query string and hash. */
function lastPathSegment(uri: string): string {
	const withoutQuery = uri.split(/[?#]/)[0] ?? uri;
	const withoutScheme = withoutQuery.includes('://')
		? withoutQuery.slice(withoutQuery.indexOf('://') + 3)
		: withoutQuery;
	const segments = withoutScheme.split('/').filter((segment) => segment.length > 0);
	return segments.at(-1) ?? withoutScheme;
}

/**
 * The provider's own opaque key rather than the URL carrying it — a Goodreads
 * id, an ISBNdb isbn, a Google Books volume id — so the same book resolves
 * identically regardless of URL shape.
 */
function providerValue(resource: string, uri: string): string {
	switch (resource) {
		case 'goodreads': {
			const match = /\/book\/show\/([^/?#]+)/.exec(uri);
			return match?.[1] ?? lastPathSegment(uri);
		}
		case 'googlebooks':
		case 'googlebooks-canonical': {
			const match = /[?&]id=([^&#]+)/.exec(uri);
			return match ? decodeURIComponent(match[1]!) : lastPathSegment(uri);
		}
		case 'isbndb': {
			const match = /\/book\/([^/?#]+)/.exec(uri);
			return match?.[1] ?? lastPathSegment(uri);
		}
		default:
			return lastPathSegment(uri);
	}
}

/** The `issuer` for a provider resource token. */
export function issuerForResource(resource: string): string {
	const token = resource.toLowerCase();
	return PROVIDER_IDENTIFIER_DOMAINS[token] ?? token;
}

/** An ISBN identifier, always carrying hyphenless ISBN-13. */
export function isbnIdentifier(raw: string): Identifier | null {
	const value = isbn13FromAny(raw);
	return value ? { issuer: 'isbn13', value } : null;
}

/** Build an identifier for a provider lookup. */
export function providerIdentifier(resource: string, uri: string): Identifier {
	return { issuer: issuerForResource(resource), value: providerValue(resource, uri) };
}

export function isIsbnIdentifier(identifier: Identifier): boolean {
	return identifier.issuer === 'isbn13' || identifier.issuer === 'isbn' || identifier.issuer === 'isbn10';
}

export function isbnValueFromIdentifier(identifier: Identifier): string | null {
	return isIsbnIdentifier(identifier) ? identifier.value : null;
}

/** Stable key for dedupe and exact comparison. */
export function identifierKey(identifier: Identifier): string {
	return `${identifier.issuer}:${identifier.value}`;
}

export function uniqueIdentifiers(identifiers: readonly Identifier[]): Identifier[] {
	const seen = new Set<string>();
	const out: Identifier[] = [];
	for (const identifier of identifiers) {
		const key = identifierKey(identifier);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(identifier);
	}
	return out;
}

export function sameIdentifier(a: Identifier, b: Identifier): boolean {
	return a.issuer === b.issuer && a.value === b.value;
}

/** Parse the wire form `<issuer>:<value>`. A hint without both halves is dropped. */
export function identifierFromString(raw: string): Identifier | null {
	const colon = raw.indexOf(':');
	if (colon <= 0 || colon === raw.length - 1) return null;
	return { issuer: raw.slice(0, colon), value: raw.slice(colon + 1) };
}

/** Render an identifier in the wire `<issuer>:<value>` form. */
export function identifierToString(identifier: Identifier): string {
	return `${identifier.issuer}:${identifier.value}`;
}
