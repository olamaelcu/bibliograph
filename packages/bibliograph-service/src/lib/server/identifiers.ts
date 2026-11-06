/**
 * Canonical `community.lexicon.book.defs#identifier` helpers.
 *
 * The lexicon compares identifiers by exact `type`/`value` equality and never
 * parses or normalises them (`defs#identifier.description`). That makes the
 * stored form load-bearing: `community.lexicon.book.resolveEditions` matches a
 * request `{type, value}` against an edition row, which is only possible if the
 * row already holds the canonical pair. Everything that writes an identifier
 * goes through this module.
 *
 * `type` is either a well-known global scheme token (`isbn`, `issn`, …) or the
 * lowercase ASCII domain of the provider that minted the identifier.
 */

 import type * as v from '@atcute/lexicons/validations';

 import type * as CommunityLexiconBookDefs from './lexicons/types/community/lexicon/book/defs.js';

 /**
 * The wire identifier, taken straight from the generated lexicon schema so the
 * storage shape cannot drift from `community.lexicon.book.defs#identifier`.
 */
 export type Identifier = v.InferInput<typeof CommunityLexiconBookDefs.identifierSchema>;

/** Identifier namespaces that are global scheme tokens rather than provider domains. */
export const GLOBAL_IDENTIFIER_TOKENS: Record<string, true> = {
	isbn: true,
	issn: true,
	doi: true,
	asin: true,
	oclc: true,
	lccn: true,
};

/**
 * Provider resource token (the legacy `resource` values) → the domain used as
 * `identifier.type`. The legacy token is kept in the same vocabulary so the
 * pre-migration rows can be converted without a lookup table per row.
 */
export const PROVIDER_IDENTIFIER_DOMAINS: Record<string, string> = {
	goodreads: 'goodreads.com',
	bookhive: 'bookhive.buzz',
	googlebooks: 'books.google.com',
	'googlebooks-canonical': 'books.google.com',
	openlibrary: 'openlibrary.org',
	isbndb: 'isbndb.com',
	hardcover: 'hardcover.app',
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

/** Legacy rows still hold `{ uri, resource }`; the migration rewrites them. */
export interface LegacyIdentifier {
	uri: string;
	resource: string;
}

/** Digits only, with a trailing `X` kept for ISBN-10. Hyphens and spaces go. */
export function normaliseIsbn(raw: string): string {
	return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

/**
 * ISBN-10 → ISBN-13. The proposal requires hyphenless ISBN-13 on write
 * ("converting ISBN-10 on write"), so a stored ISBN-10 is not representable.
 */
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
 * The `identifier.value` for a provider identifier, i.e. the provider's own
 * opaque key rather than the URL carrying it. Values are the provider's stable
 * identity — a Goodreads id, an ISBNdb isbn, a Google Books volume id —
 * so the same book resolves identically regardless of URL shape.
 */
function providerValue(resource: string, uri: string): string {
	switch (resource) {
		case 'goodreads': {
			const match = /\/book\/show\/([^/?#]+)/.exec(uri);
			return match?.[1] ?? lastPathSegment(uri);
		}
		case 'bookhive': {
			// `at://did/collection/rkey`
			const segments = uri.split('/');
			return segments.at(-1) ?? uri;
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
		case 'wikidata':
		case 'viaf':
		case 'isni':
		case 'imdb':
			return lastPathSegment(uri);
		default:
			return lastPathSegment(uri);
	}
}

/** The `identifier.type` for a legacy resource token. */
export function identifierTypeForResource(resource: string): string {
	const token = resource.toLowerCase();
	if (token === 'isbn' || token === 'isbn10' || token === 'isbn13') return 'isbn';
	if (GLOBAL_IDENTIFIER_TOKENS[token] === true) return token;
	return PROVIDER_IDENTIFIER_DOMAINS[token] ?? token;
}

/** An ISBN identifier, always carrying hyphenless ISBN-13. */
export function isbnIdentifier(raw: string): Identifier | null {
	const value = isbn13FromAny(raw);
	return value ? { type: 'isbn', value } : null;
}

/**
 * Build an identifier for a provider lookup. `url` keeps the provider's
 * canonical page, which is display-only and never compared.
 */
export function providerIdentifier(resource: string, uri: string): Identifier {
	const type = identifierTypeForResource(resource);
	if (type === 'isbn') {
		const isbn = isbnIdentifier(uri);
		if (isbn) return isbn;
	}
	const value = providerValue(resource.toLowerCase(), uri);
	const identifier: Identifier = { type, value };
	const url = displayUrl(uri);
	if (url !== undefined) identifier.url = url;
	return identifier;
}

/**
 * Whether a URI can serve as `identifier.url`.
 *
 * `url` is display/reference only, so it must be fetchable. The contributor
 * resolver mints synthetic `googlebooks://contributor/<slug>` keys that name the
 * namespace but are not a real address, and those are dropped.
 */
export function displayUrl(uri: string | undefined): Identifier['url'] | undefined {
	return uri !== undefined && /^(?:https?:\/\/|at:\/\/)/.test(uri) ? (uri as Identifier['url']) : undefined;
}

/** Convert a stored pre-migration `{ uri, resource }` identifier. */
export function identifierFromLegacy(legacy: LegacyIdentifier): Identifier {
	if (identifierTypeForResource(legacy.resource) === 'isbn') {
		const isbn = isbnIdentifier(legacy.uri);
		if (isbn) return isbn;
	}
	return providerIdentifier(legacy.resource, legacy.uri);
}

/** Whether an identifier belongs to the ISBN namespace. */
export function isIsbnIdentifier(identifier: Identifier): boolean {
	return identifier.type === 'isbn';
}

/** The hyphenless ISBN-13 an identifier carries, or null. */
export function isbnValueFromIdentifier(identifier: Identifier): string | null {
	if (!isIsbnIdentifier(identifier)) return null;
	const value = isbn13FromAny(identifier.value);
	return value === identifier.value ? value : null;
}

/** Stable key for dedupe and comparison: `type` + `value`, never the URL. */
export function identifierKey(identifier: Identifier): string {
	return `${identifier.type}\u0000${identifier.value}`;
}

/** Dedupe by exact `type`/`value`, preserving first-seen order. */
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

/** Exact-match helper mirroring the lexicon's comparison rules. */
export function sameIdentifier(a: Identifier, b: Identifier): boolean {
	return a.type === b.type && a.value === b.value;
}

/**
 * Provider domain → the legacy resource token that names it. Used to interpret
 * free-form identifier strings (the still-query-shaped `searchWorks`,
 * `searchContributors` and `searchPublishers` take `id` URLs/URNs).
 */
const RESOURCE_BY_DOMAIN: Record<string, string> = Object.fromEntries(
	Object.entries(PROVIDER_IDENTIFIER_DOMAINS).map(([resource, domain]) => [domain, resource]),
);

/**
 * Interpret a free-form identifier string (`isbn:…`, `urn:isbn:…`, a provider
 * URL) as a canonical identifier, or null when it names no known namespace.
 */
export function identifierFromString(raw: string): Identifier | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const lower = trimmed.toLowerCase();
	for (const prefix of ['urn:isbn:', 'isbn:']) {
		if (lower.startsWith(prefix)) return isbnIdentifier(trimmed.slice(prefix.length));
	}

	if (lower.startsWith('http://') || lower.startsWith('https://')) {
		let host: string;
		try {
			host = new URL(trimmed).hostname.toLowerCase();
		} catch {
			return null;
		}
		const withoutWww = host.replace(/^www\./, '');
		const resource = RESOURCE_BY_DOMAIN[withoutWww] ?? RESOURCE_BY_DOMAIN[host];
		if (!resource) return null;
		return providerIdentifier(resource, trimmed);
	}

	if (lower.startsWith('at://')) {
		// Bookhive catalog records and the AppView's own record uris.
		const resource = trimmed.includes('/buzz.bookhive.') ? 'bookhive' : undefined;
		if (resource) return providerIdentifier(resource, trimmed);
		return null;
	}

	// A bare global token form such as `doi:10.1000/xyz`.
	const match = /^([a-z]+):(.+)$/i.exec(trimmed);
	if (match && GLOBAL_IDENTIFIER_TOKENS[match[1]!.toLowerCase()] === true) {
		const type = match[1]!.toLowerCase();
		if (type === 'isbn') return isbnIdentifier(match[2]!);
		return { type, value: match[2]! };
	}

	return null;
}
