import type { Identifier } from './identifiers';
import type { AppviewBookRow, SeriesValue } from './catalog/types';

/** `community.lexicon.media.book.defs#contributor`, inline in an edition view. */
export interface EditionContributorView {
	name: string;
	role?: string;
	identifiers?: Identifier[];
	ref?: string;
}

/** `community.lexicon.media.book.defs#publisher`. */
export interface EditionPublisherView {
	name: string;
	identifiers?: Identifier[];
}

/** `community.lexicon.media.book.defs#editionView`. */
export interface EditionView {
	title: string;
	identifiers: Identifier[];
	contributors: EditionContributorView[];
	createdAt: string;
	coverUrl?: string;
	subtitle?: string;
	language?: string;
	publishedDate?: string;
	publisher?: EditionPublisherView;
	format?: string;
	pages?: number;
	durationSeconds?: number;
	chapters?: number;
	series?: SeriesValue;
	bookEdition?: string;
	description?: string;
}

/** `net.olamaelcu.livtet.biblio.defs#bookView`. */
export interface BookView {
	uri: string;
	edition: EditionView;
}

const PRINT_FORMATS = new Set([
	'hardcover',
	'paperback',
	'mass_market_paperback',
	'board_book',
	'spiral_bound',
	'physical',
	'print',
]);

/**
 * Stored provider binding → the lexicon's medium token. The lexicon permits
 * additional values, but print bindings all mean `physical`, and clients should
 * not have to know a provider's vocabulary.
 */
export function formatToWire(format: string | null | undefined): string | undefined {
	if (!format) return undefined;
	const token = format.trim().toLowerCase();
	if (!token) return undefined;
	if (PRINT_FORMATS.has(token)) return 'physical';
	if (token === 'ebook' || token === 'e-book' || token === 'kindle') return 'ebook';
	if (token === 'audiobook' || token === 'audio') return 'audio';
	return token;
}

/** `YYYY` from a stored year, preserving precision. */
export function publishedDateFromYear(year: number | null | undefined): string | undefined {
	if (year === null || year === undefined) return undefined;
	if (!Number.isInteger(year) || year < 1000 || year > 9999) return undefined;
	return String(year);
}

/** Placeholder art providers serve as a real URL; never store or return it. */
export function usableCoverUrl(url: string | null | undefined): string | undefined {
	if (!url) return undefined;
	const value = url.trim();
	if (!/^https?:\/\//i.test(value)) return undefined;
	if (/(?:nophoto|no-cover|nocover|placeholder|missing[_-]?cover)/i.test(value)) return undefined;
	return value;
}

function isoString(value: Date | string | null): string | undefined {
	if (!value) return undefined;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Map one `appview_book` row to `defs#editionView`. */
export function editionViewFromAppview(row: AppviewBookRow): EditionView {
	const view: EditionView = {
		title: row.title,
		identifiers: Array.isArray(row.identifiers) ? row.identifiers : [],
		contributors: (Array.isArray(row.contributors) ? row.contributors : []).map((entry) => {
			const contributor: EditionContributorView = {
				name: entry.name,
				role: entry.role || 'author',
			};
			if (entry.identifiers?.length) contributor.identifiers = entry.identifiers;
			if (entry.ref) contributor.ref = entry.ref;
			return contributor;
		}),
		createdAt: isoString(row.created_at) ?? new Date(0).toISOString(),
	};
	if (row.subtitle) view.subtitle = row.subtitle;
	if (row.language) view.language = row.language;
	if (row.published_date) view.publishedDate = row.published_date;
	const format = formatToWire(row.format);
	if (format) view.format = format;
	if (row.pages !== null && row.pages !== undefined) view.pages = row.pages;
	if (row.duration_seconds !== null && row.duration_seconds !== undefined) view.durationSeconds = row.duration_seconds;
	if (row.chapters !== null && row.chapters !== undefined) view.chapters = row.chapters;
	if (row.series) view.series = row.series;
	if (row.book_edition) view.bookEdition = row.book_edition;
	if (row.description) view.description = row.description;
	const coverUrl = usableCoverUrl(row.cover_url);
	if (coverUrl) view.coverUrl = coverUrl;
	if (row.publisher) {
		const publisher: EditionPublisherView = { name: row.publisher.name };
		if (row.publisher.identifiers?.length) publisher.identifiers = row.publisher.identifiers;
		view.publisher = publisher;
	}
	return view;
}

/** `defs#bookView` for one row. */
export function bookViewFromAppview(row: AppviewBookRow): BookView {
	return { uri: row.uri, edition: editionViewFromAppview(row) };
}

/** Stored catalog format tokens. */
export type BookFormat =
	| 'hardcover'
	| 'paperback'
	| 'mass_market_paperback'
	| 'ebook'
	| 'audiobook'
	| 'board_book'
	| 'spiral_bound';

const BINDING_ALIASES: Record<string, string> = {
	hardcover: 'hardcover',
	'hardback': 'hardcover',
	paperback: 'paperback',
	'softcover': 'paperback',
	'mass market paperback': 'mass_market_paperback',
	'mass_market_paperback': 'mass_market_paperback',
	ebook: 'ebook',
	'kindle edition': 'ebook',
	audiobook: 'audiobook',
	'audio cd': 'audiobook',
	'board book': 'board_book',
	board_book: 'board_book',
	'spiral-bound': 'spiral_bound',
	spiral_bound: 'spiral_bound',
};

/** Provider binding string → the stored catalog format token. */
export function normalizeBookFormat(raw: string | null | undefined): BookFormat | undefined {
	if (!raw) return undefined;
	const value = raw.trim().toLowerCase();
	if (!value) return undefined;
	const normalized = BINDING_ALIASES[value] ?? value.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
	return normalized as BookFormat;
}
