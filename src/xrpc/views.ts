import { and, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as Lexicons from '../lexicons/index.js';
import type {
	ActorView,
	BookContributorView,
	BookShelfView,
	BookView,
	ContributorView,
	FormatView,
	GenreView,
	Identifier,
	Progress,
	ReviewView,
	ShelfView,
	ShelfWithBooksView,
	WorkView,
} from '../lexicons/types/net/olamaelcu/livtet/biblio/defs.js';
import {
	contributors,
	contributorIdentifiers,
	bookContributors,
	bookGenres,
	bookIdentifiers,
	books,
	contributorRoles,
	formats,
	genreIdentifiers,
	genres,
	workIdentifiers,
	works,
} from '../db/schema.js';
import { releasedFilter } from './gate.js';

export const COLLECTION = {
	book: 'net.olamaelcu.livtet.biblio.book',
	work: 'net.olamaelcu.livtet.biblio.work',
	contributor: 'net.olamaelcu.livtet.biblio.contributor',
	contributorRole: 'net.olamaelcu.livtet.biblio.contributorRole',
	format: 'net.olamaelcu.livtet.biblio.format',
	genre: 'net.olamaelcu.livtet.biblio.genre',
	review: 'net.olamaelcu.livtet.biblio.review',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelf: 'net.olamaelcu.livtet.biblio.bookShelving',
	actor: 'net.olamaelcu.livtet.biblio.actor',
} as const;

type Db = BetterSQLite3Database;

export interface ViewContext {
	serviceDid: string;
}

/** A record returned by the user's PDS (`com.atproto.repo.*`). */
export interface PdsRecord {
	uri: string;
	cid: string;
	value: unknown;
}

function atUri(ctx: ViewContext, collection: string, pk: string): string {
	return `at://${ctx.serviceDid}/${collection}/${pk}`;
}

function toIso(seconds: number | null | undefined): string | undefined {
	return seconds == null ? undefined : new Date(seconds * 1000).toISOString();
}

/** Branded generic URI (format:value) produced by codegen for uri-format strings. */
type GenericUri = `${string}:${string}`;
function toUri(value: string): GenericUri {
	return value as GenericUri;
}

/**
 * Extract the record key (rkey) from an at-uri of the form
 * `at://<did>/<collection>/<rkey>`, validating the collection.
 */
export function rkeyFromAtUri(uri: string, collection: string): string | undefined {
	if (!uri.startsWith('at://')) return undefined;
	const parts = uri.slice('at://'.length).split('/');
	if (parts.length !== 3 || parts[1] !== collection || parts[2] === '') return undefined;
	return parts[2];
}

/** rkey of the canonical catalog book referenced by an `expandedBook.ref`. */
export function bookRkeyFromRef(ref: string | undefined): string | undefined {
	return ref ? rkeyFromAtUri(ref, COLLECTION.book) : undefined;
}

// ─── Identifiers ─────────────────────────────────────────────────────────────

interface IdentifierRow {
	resource: string;
	url: string;
}

function toIdentifiers(rows: IdentifierRow[]): Identifier[] {
	return rows.map((r) => ({ resource: r.resource, url: toUri(r.url) }));
}

// ─── Formats ─────────────────────────────────────────────────────────────────

export function toFormatView(
	ctx: ViewContext,
	f: { pk: string; description: string; emoji: string; iconImageUrl: string | null; unit: string },
): FormatView {
	return {
		uri: atUri(ctx, COLLECTION.format, f.pk) as FormatView['uri'],
		description: f.description,
		emoji: f.emoji,
		iconImageUrl: f.iconImageUrl ? toUri(f.iconImageUrl) : undefined,
		unit: f.unit,
	};
}

// ─── Works ───────────────────────────────────────────────────────────────────

export function toWorkView(
	ctx: ViewContext,
	w: {
		pk: string;
		title: string;
		description: string | null;
		originalPublishDate: number | null;
		createdAt: number;
		updatedAt: number | null;
	},
	identifiers: IdentifierRow[],
): WorkView {
	return {
		uri: atUri(ctx, COLLECTION.work, w.pk) as WorkView['uri'],
		title: w.title,
		identifiers: toIdentifiers(identifiers),
		description: w.description ?? undefined,
		originalPublishDate: toIso(w.originalPublishDate),
		createdAt: toIso(w.createdAt),
		updatedAt: toIso(w.updatedAt),
	};
}

// ─── Genres ──────────────────────────────────────────────────────────────────

export function toGenreView(
	ctx: ViewContext,
	g: {
		pk: string;
		name: string;
		emoji: string;
		description: string;
		iconImageUrl: string | null;
		parentPk: string | null;
	},
	identifiers: IdentifierRow[],
): GenreView {
	return {
		uri: atUri(ctx, COLLECTION.genre, g.pk) as GenreView['uri'],
		name: g.name,
		emoji: g.emoji,
		description: g.description,
		iconImageUrl: g.iconImageUrl ? toUri(g.iconImageUrl) : undefined,
		identifiers: toIdentifiers(identifiers),
		parent: g.parentPk ? (atUri(ctx, COLLECTION.genre, g.parentPk) as GenreView['parent']) : undefined,
	};
}

// ─── Contributors ────────────────────────────────────────────────────────────

export function toContributorView(
	ctx: ViewContext,
	c: {
		pk: string;
		name: string;
		sortName: string | null;
		bio: string | null;
		imageUrl: string | null;
		createdAt: number;
		updatedAt: number | null;
	},
	identifiers: IdentifierRow[],
): ContributorView {
	return {
		uri: atUri(ctx, COLLECTION.contributor, c.pk) as ContributorView['uri'],
		name: c.name,
		sortName: c.sortName ?? undefined,
		identifiers: toIdentifiers(identifiers),
		bio: c.bio ?? undefined,
		imageUrl: c.imageUrl ? toUri(c.imageUrl) : undefined,
		createdAt: toIso(c.createdAt),
		updatedAt: toIso(c.updatedAt),
	};
}

// ─── Books ───────────────────────────────────────────────────────────────────

export async function toBookView(
	db: Db,
	ctx: ViewContext,
	b: {
		pk: string;
		title: string;
		workPk: string | null;
		formatPk: string | null;
		publishDate: number | null;
		description: string | null;
		coverUrl: string | null;
		createdAt: number;
		updatedAt: number | null;
	},
): Promise<BookView> {
	const [workRow, formatRow, genreRows, contributorRows, identifierRows] = await Promise.all([
		b.workPk
			? db.select().from(works).where(and(eq(works.pk, b.workPk), releasedFilter(works))).get()
			: undefined,
		b.formatPk ? db.select().from(formats).where(eq(formats.pk, b.formatPk)).get() : undefined,
		(async () => {
			if (!b.workPk) return [];
			const joins = db
				.select({ genre: genres })
				.from(bookGenres)
				.innerJoin(genres, eq(bookGenres.genrePk, genres.pk))
				.where(and(eq(bookGenres.bookPk, b.pk), releasedFilter(genres)))
				.all();
			return joins.map((j) => j.genre);
		})(),
		(async () => {
			const joins = db
				.select({ contributor: contributors, role: contributorRoles })
				.from(bookContributors)
				.innerJoin(contributors, eq(bookContributors.contributorPk, contributors.pk))
				.innerJoin(contributorRoles, eq(bookContributors.rolePk, contributorRoles.pk))
				.where(and(eq(bookContributors.bookPk, b.pk), releasedFilter(contributors as never)))
				.all();
			return joins;
		})(),
		db.select().from(bookIdentifiers).where(eq(bookIdentifiers.bookPk, b.pk)).all(),
	]);

	const [workIds, genreIds, contributorIds] = await Promise.all([
		b.workPk
			? db.select().from(workIdentifiers).where(eq(workIdentifiers.workPk, b.workPk)).all()
			: Promise.resolve([]),
		genreRows.length
			? db
					.select()
					.from(genreIdentifiers)
					.where(inArray(genreIdentifiers.genrePk, genreRows.map((g) => g.pk)))
					.all()
			: Promise.resolve([]),
		contributorRows.length
			? db
					.select()
					.from(contributorIdentifiers)
					.where(inArray(contributorIdentifiers.contributorPk, contributorRows.map((c) => c.contributor.pk)))
					.all()
			: Promise.resolve([]),
	]);

	const idByGenre = new Map<string, IdentifierRow[]>();
	for (const row of genreIds) {
		const list = idByGenre.get(row.genrePk) ?? [];
		list.push(row);
		idByGenre.set(row.genrePk, list);
	}
	const idByContributor = new Map<string, IdentifierRow[]>();
	for (const row of contributorIds) {
		const list = idByContributor.get(row.contributorPk) ?? [];
		list.push(row);
		idByContributor.set(row.contributorPk, list);
	}

	return {
		uri: atUri(ctx, COLLECTION.book, b.pk) as BookView['uri'],
		title: b.title,
		work: workRow ? toWorkView(ctx, workRow, workIds) : undefined,
		format: formatRow ? toFormatView(ctx, formatRow) : undefined,
		genres: genreRows.map((g) => toGenreView(ctx, g, idByGenre.get(g.pk) ?? [])),
		contributors: contributorRows.map(({ contributor, role }) => ({
			bookUri: atUri(ctx, COLLECTION.book, b.pk) as BookContributorView['bookUri'],
			contributor: toContributorView(ctx, contributor, idByContributor.get(contributor.pk) ?? []),
			role: atUri(ctx, COLLECTION.contributorRole, role.pk) as BookContributorView['role'],
		})),
		identifiers: toIdentifiers(identifierRows),
		publishDate: toIso(b.publishDate),
		description: b.description ?? undefined,
		coverUrl: b.coverUrl ? toUri(b.coverUrl) : undefined,
		createdAt: toIso(b.createdAt),
		updatedAt: toIso(b.updatedAt),
	};
}

// ─── User PDS records → views ────────────────────────────────────────────────

/**
 * Hydrate the progress indicator of a PDS review record. The stored record
 * references its format by at-uri (strong ref); the view embeds a format object
 * hydrated from the local catalog. Returns undefined when the record has no
 * progress or its format is not in the catalog.
 */
async function toProgressView(
	db: Db,
	ctx: ViewContext,
	progress: unknown,
): Promise<ReviewView['progress']> {
	if (!progress || typeof progress !== 'object') return undefined;
	const p = progress as { format?: unknown; progress?: number; unit?: string };
	if (typeof p.format !== 'string') return undefined;
	const formatPk = rkeyFromAtUri(p.format, COLLECTION.format);
	const formatRow = formatPk ? db.select().from(formats).where(eq(formats.pk, formatPk)).get() : undefined;
	if (!formatRow) return undefined;

	return {
		format: {
			$type: 'net.olamaelcu.livtet.biblio.format',
			description: formatRow.description,
			emoji: formatRow.emoji,
			iconImageUrl: formatRow.iconImageUrl ? toUri(formatRow.iconImageUrl) : undefined,
			unit: formatRow.unit as Progress['format']['unit'],
		},
		progress: p.progress,
		unit: p.unit,
	};
}

/** Build a shelfView from a user PDS shelf record. */
export function toShelfView(rec: PdsRecord): ShelfView {
	const value = rec.value as Lexicons.NetOlamaelcuLivtetBiblioShelf.Main;
	return {
		uri: rec.uri as ShelfView['uri'],
		name: value.name,
		description: value.description,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/**
 * Build a reviewView from a user PDS review record. `book` is the catalog book
 * view hydrated by the caller (which has already resolved the record's
 * `book.ref`); callers must not render a review whose book could not be
 * hydrated.
 */
export async function toReviewView(
	db: Db,
	ctx: ViewContext,
	rec: PdsRecord,
	did: string,
	book: BookView,
): Promise<ReviewView> {
	const value = rec.value as Lexicons.NetOlamaelcuLivtetBiblioReview.Main;
	return {
		uri: rec.uri as ReviewView['uri'],
		book,
		did: did as ReviewView['did'],
		tags: value.tags ?? [],
		rating: value.rating,
		status: value.status,
		progress: await toProgressView(db, ctx, value.progress),
		text: value.text,
		createdAt: value.createdAt,
	};
}

/** Build a bookShelfView from a user PDS bookShelving record. */
export function toBookShelfView(
	rec: PdsRecord,
	did: string,
	shelf: ShelfView,
	book: BookView,
): BookShelfView {
	const value = rec.value as Lexicons.NetOlamaelcuLivtetBiblioBookShelving.Main;
	return {
		uri: rec.uri as BookShelfView['uri'],
		shelf,
		book,
		metadata: value.metadata,
		did: did as BookShelfView['did'],
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/** Build a shelfWithBooksView from a shelfView plus its hydrated books. */
export function toShelfWithBooksView(shelf: ShelfView, books: BookShelfView[]): ShelfWithBooksView {
	return { shelf, books };
}

/** Build an actorView from the authenticated session and the actor self record (if any). */
export function toActorView(
	rec: PdsRecord | undefined,
	session: { did: string; handle?: string },
): ActorView {
	const value = rec?.value as Lexicons.NetOlamaelcuLivtetBiblioActor.Main | undefined;
	return {
		did: session.did as ActorView['did'],
		handle: session.handle,
		displayName: value?.displayName,
		description: value?.description,
	};
}
