import type * as v from '@atcute/lexicons/validations';

import type {
	contributorSchema as ContributorSchema,
	editionViewSchema as EditionViewSchema,
} from './lexicons/types/community/lexicon/book/defs.js';
import type { ContributionEntry, EditionItem, Identifier } from './search/types';

/**
 * Boundary between the local storage shapes and the
 * `community.lexicon.book.*` wire shapes.
 *
 * Storage deliberately keeps two things the lexicon does not:
 *
 * - `editions.contributors` holds strongRefs (`{ subject: { uri, cid }, role }`)
 *   so a contributor record update is detectable. The lexicon's
 *   `defs#contributor` inlines `name` and allows only a loose `ref` at-uri, so
 *   the strongRef is expanded here, at the response boundary.
 * - `place` / `publishedYear` / `coverImageUrl` are column names. The lexicon
 *   uses `publishedDate` (precision-preserving string) and `coverUrl`.
 *
 * `identifiers` is the exception: those are migrated to the canonical
 * `{ type, value }` form in the database, because the lexicon compares
 * identifiers by exact equality and `resolveEditions` matches on them.
 */

// `InferOutput` (not `InferInput`): the schema declares `role` with a default,
// so an emitted contributor always carries a resolved role.
type EditionView = v.InferOutput<typeof EditionViewSchema>;
export type Contributor = v.InferOutput<typeof ContributorSchema>;

/** The lexicon's contributor role union. */
export type ContributorRole = NonNullable<Contributor['role']>;

/** Contributor record fields the wire shape inlines. */
export interface ContributorRef {
	name: string;
	identifiers?: Identifier[];
}

/**
 * Legacy contribution roles → the lexicon's `knownValues`. `coAuthor` became
 * `co-author`; every other stored role is already a lexicon value, and unknown
 * values pass through (ATProto knownValues are advisory).
 */
export function roleToWire(role: string): ContributorRole {
	// `knownValues` are advisory in ATProto, so an unrecognised stored role is
	// passed through rather than silently rewritten to `author`.
	return (role === 'coAuthor' ? 'co-author' : role) as ContributorRole;
}

/**
 * Expand a stored strongRef into `defs#contributor`. Entries whose contributor
 * row has no name yet are dropped: `name` is required and `minLength: 1`, so
 * emitting them would produce a record the lexicon rejects.
 */
export function contributorToWire(
	entry: ContributionEntry,
	resolved: ContributorRef | undefined,
): Contributor | null {
	const name = resolved?.name?.trim();
	if (!resolved || !name) return null;
	const contributor: Contributor = { name, role: roleToWire(entry.role) };
	if (resolved.identifiers && resolved.identifiers.length > 0) {
		contributor.identifiers = resolved.identifiers;
	}
	contributor.ref = entry.subject.uri as Contributor['ref'];
	return contributor;
}

/**
 * Expand a list of stored strongRefs into `defs#contributor` entries. Entries
 * whose contributor record has no name are dropped rather than emitted with an
 * empty `name`, which the lexicon rejects.
 */
export function wireContributors(
	entries: ReadonlyArray<ContributionEntry> | null | undefined,
	refs: Map<string, ContributorRef>,
): Contributor[] {
	const out: Contributor[] = [];
	for (const entry of entries ?? []) {
		const contributor = contributorToWire(entry, refs.get(entry.subject.uri));
		if (contributor) out.push(contributor);
	}
	return out;
}

/** Stored `format` → the lexicon's medium. Unknown formats pass through. */
export function formatToWire(format: string | undefined): string | undefined {
	switch (format) {
		case undefined:
			return undefined;
		case 'hardcover':
		case 'paperback':
		case 'physical':
			return 'physical';
		case 'ebook':
			return 'ebook';
		case 'audiobook':
		case 'audio':
			return 'audio';
		default:
			return format;
	}
}

/**
 * Stored publication year → `publishedDate`. The lexicon accepts `YYYY`,
 * `YYYY-MM` or `YYYY-MM-DD` and forbids inventing a month or day, so a bare
 * year stays a bare year.
 */
export function publishedDateFromYear(year: number | null | undefined): string | undefined {
	if (year === null || year === undefined) return undefined;
	if (!Number.isInteger(year) || year < 0 || year > 9999) return undefined;
	return String(year).padStart(4, '0');
}

/** Publisher name → `defs#publisher`. `name` is required and non-empty. */
export function publisherToWire(name: string | null | undefined): { name: string } | undefined {
	const trimmed = name?.trim();
	return trimmed ? { name: trimmed } : undefined;
}

/**
 * A provider's "no cover" placeholder is not a cover.
 *
 * Goodreads — and the Bookhive catalog derived from it — serves
 * `…/nophoto/book/…png` for books without artwork. Passing that as `coverUrl`
 * makes readers (and their image proxies) treat a grey placeholder as real
 * artwork, so the record omits the field instead; the lexicon makes it
 * optional.
 */
export function usableCoverUrl(url: string | null | undefined): string | undefined {
	if (!url) return undefined;
	return /nophoto/i.test(url) ? undefined : url;
}

/**
 * Build a `defs#editionView` from a stored edition row plus resolved
 * contributor records. `identifiers` must already be canonical and non-empty —
 * `defs#editionView` requires `minLength: 1`.
 */
export function editionViewFromItem(
	item: EditionItem,
	contributorsByUri: Map<string, ContributorRef>,
	publisherName?: string | null,
): EditionView {
	const contributors: Contributor[] = [];
	for (const entry of item.contributors ?? []) {
		const contributor = contributorToWire(entry, contributorsByUri.get(entry.subject.uri));
		if (contributor) contributors.push(contributor);
	}

	const view: EditionView = {
		title: item.title,
		identifiers: item.identifiers,
		contributors,
		createdAt: item.createdAt,
	};
	if (item.subtitle) view.subtitle = item.subtitle;
	if (item.language) view.language = item.language;
	if (item.description) view.description = item.description;
	const coverUrl = usableCoverUrl(item.coverImageUrl);
	if (coverUrl) view.coverUrl = coverUrl as EditionView['coverUrl'];
	if (item.pages !== undefined) view.pages = item.pages;
	const publishedDate = publishedDateFromYear(item.publishedYear);
	if (publishedDate) view.publishedDate = publishedDate;
	const format = formatToWire(item.format);
	if (format) view.format = format;
	const publisher = publisherToWire(publisherName);
	if (publisher) view.publisher = publisher;
	return view;
}
