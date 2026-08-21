import type { BookContributorView, BookView, ContributorView, Identifier } from '../lexicons/types/net/olamaelcu/livtet/biblio/defs.js';
import { getEngagementForSubject } from '../network/constellation.js';
import type { GbVolume, GbVolumeInfo } from './client.js';
import type { ViewContext } from '../lex/collections.js';
import { COLLECTION } from '../lex/collections.js';

/**
 * Normalize a free-form author name into a stable rkey slug. Lowercases,
 * strips diacritics, replaces non-alphanumerics with `-`, collapses runs.
 * Empty/Unicode-only names fall back to a deterministic FNV-1a hash prefixed
 * with `xn-` (Punycode-style "this is an encoded name"). The `xn-` marker
 * avoids collisions with real names that legitimately slugify to a `c-...`
 * shape (e.g., "C. S. Lewis" → `gbauthors-c-s-lewis`).
 */
function authorSlug(name: string): string {
	const ascii = name
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (ascii.length > 0) return `gbauthors-${ascii}`;
	let h = 0x811c9dc5;
	for (const ch of name) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 0x01000193);
	}
	return `gbauthors-xn-${(h >>> 0).toString(36)}`;
}

/**
 * Inverse of {@link authorSlug}. Strips the `gbauthors-` prefix and the
 * optional `xn-` hash-fallback marker, then maps `-` back to spaces.
 *
 * Throws on malformed slugs that aren't `gbauthors-{...}` so callers can
 * fail loudly rather than emit garbage queries.
 */
export function gbAuthorSlugToName(slug: string): string {
	const match = slug.match(/^gbauthors-(?:xn-([a-z0-9]+)|(.+))$/);
	if (!match) throw new Error(`not a gbauthor slug: ${slug}`);
	const body = match[1] ?? match[2] ?? '';
	return body.replace(/-/g, ' ');
}

function asUri(value: string): `${string}:${string}` {
	return value as `${string}:${string}`;
}

function gbAuthorsToContributors(ctx: ViewContext, authors: string[] | undefined): ContributorView[] {
	if (!authors?.length) return [];
	return authors.map((name) => {
		const slug = authorSlug(name);
		const uri = `at://${ctx.serviceDid}/${COLLECTION.contributor}/${slug}` as ContributorView['uri'];
		return { uri, name };
	});
}

function gbAuthorsToBookContributors(
	ctx: ViewContext,
	bookUri: string,
	authors: string[] | undefined,
): BookContributorView[] {
	if (!authors?.length) return [];
	const contributors = gbAuthorsToContributors(ctx, authors);
	return contributors.map((contributor) => {
		const slug = authorSlug(contributor.name);
		return {
			bookUri: bookUri as BookContributorView['bookUri'],
			contributor,
			role: `at://${ctx.serviceDid}/${COLLECTION.contributorRole}/author` as BookContributorView['role'],
		};
	});
}

function gbIdentifiersToIdentifiers(volumeId: string, info: GbVolumeInfo): Identifier[] {
	const items: Identifier[] = [];
	const url = `https://books.google.com/books?id=${volumeId}`;
	if (info.industryIdentifiers) {
		for (const id of info.industryIdentifiers) {
			const resource = `${id.type.toLowerCase()}:${id.identifier}`;
			items.push({ resource, url: asUri(url) });
		}
	}
	return items;
}

/** Parse Google's partial `publishedDate` (YYYY, YYYY-MM, YYYY-MM-DD) to a unix-second timestamp. */
function parsePublishedDate(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const match = value.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
	if (!match) return undefined;
	const [, y, m = '01', d = '01'] = match;
	const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
	// Reject silent rollovers: Feb 30, Apr 31, month 13, etc. Date.UTC happily
	// spills these into the next month/year; round-trip and compare.
	const back = new Date(ms);
	if (
		back.getUTCFullYear() !== Number(y) ||
		back.getUTCMonth() !== Number(m) - 1 ||
		back.getUTCDate() !== Number(d)
	) {
		return undefined;
	}
	return Math.floor(ms / 1000);
}

function gbCoverUrl(info: GbVolumeInfo): string | undefined {
	const normalize = (u?: string) => u?.replace(/^http:\/\//, 'https://');
	return normalize(info.imageLinks?.thumbnail) ?? normalize(info.imageLinks?.smallThumbnail);
}

export async function gbVolumeToBookView(ctx: ViewContext, volume: GbVolume): Promise<BookView | undefined> {
	const info = volume.volumeInfo;
	if (!info?.title) return undefined;
	const slug = `gb-${volume.id}`;
	const bookUri = `at://${ctx.serviceDid}/${COLLECTION.book}/${slug}`;
	const view: BookView = {
		uri: bookUri as BookView['uri'],
		title: info.title,
		identifiers: gbIdentifiersToIdentifiers(volume.id, info),
		contributors: gbAuthorsToBookContributors(ctx, bookUri, info.authors),
	};
	const published = parsePublishedDate(info.publishedDate);
	if (published != null) view.publishDate = new Date(published * 1000).toISOString();
	if (info.description) view.description = info.description;
	const cover = gbCoverUrl(info);
	if (cover) view.coverUrl = asUri(cover);
	// Attach bsky engagement using the canonical at-uri of this GB-backed book.
	// People who post about the book would use this URI shape, so constellation
	// hits resolve naturally.
	const bsky = await getEngagementForSubject(bookUri);
	if (bsky && (bsky.likeCount > 0 || bsky.quoteCount > 0)) {
		view.bsky = { likeCount: bsky.likeCount, quoteCount: bsky.quoteCount };
	}
	return view;
}

/** Opaque cursor encoding `{ q, startIndex }` for `listBooks` / `searchBooks`. */
export interface GbCursor {
	q: string;
	startIndex: number;
}

export function encodeGbCursor(cursor: GbCursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeGbCursor(value: string | undefined): GbCursor | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
		if (
			parsed &&
			typeof parsed === 'object' &&
			typeof (parsed as GbCursor).q === 'string' &&
			typeof (parsed as GbCursor).startIndex === 'number'
		) {
			return { q: (parsed as GbCursor).q, startIndex: (parsed as GbCursor).startIndex };
		}
	} catch {
		return undefined;
	}
	return undefined;
}