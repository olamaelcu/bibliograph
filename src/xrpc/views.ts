import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type {
	BookContributorView,
	BookShelfMetadata,
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
	bookShelves,
	books,
	contributorRoles,
	formats,
	genreIdentifiers,
	genres,
	reviewBlobs,
	reviews,
	reviewTags,
	shelves,
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
} as const;

type Db = BetterSQLite3Database;

export interface ViewContext {
	serviceDid: string;
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

/** Branded DID string produced by codegen for did-format strings. */
function toDid(value: string): `did:${string}:${string}` {
	return value as `did:${string}:${string}`;
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

// ─── Shelves ─────────────────────────────────────────────────────────────────

export function toShelfView(
	ctx: ViewContext,
	s: { pk: string; name: string; description: string | null; createdAt: number; updatedAt: number | null },
): ShelfView {
	return {
		uri: atUri(ctx, COLLECTION.shelf, s.pk) as ShelfView['uri'],
		name: s.name,
		description: s.description ?? undefined,
		createdAt: toIso(s.createdAt),
		updatedAt: toIso(s.updatedAt),
	};
}

// ─── Book Shelving ───────────────────────────────────────────────────────────

export async function toBookShelfView(
	db: Db,
	ctx: ViewContext,
	bs: {
		pk: string;
		did: string;
		bookPk: string;
		shelfPk: string;
		position: number | null;
		notes: string | null;
		emoji: string | null;
		status: string;
		createdAt: number;
		updatedAt: number | null;
	},
): Promise<BookShelfView> {
	const [shelfRow, bookRow] = await Promise.all([
		db.select().from(shelves).where(eq(shelves.pk, bs.shelfPk)).get(),
		db.select().from(books).where(eq(books.pk, bs.bookPk)).get(),
	]);

	if (!shelfRow) {
		throw new Error(`bookShelving ${bs.pk} references missing shelf ${bs.shelfPk}`);
	}
	if (!bookRow) {
		throw new Error(`bookShelving ${bs.pk} references missing book ${bs.bookPk}`);
	}

	const metadata: BookShelfMetadata = {
		status: bs.status,
		position: bs.position ?? undefined,
		notes: bs.notes ?? undefined,
		emoji: bs.emoji ?? undefined,
	};

	return {
		uri: atUri(ctx, COLLECTION.bookShelf, bs.pk) as BookShelfView['uri'],
		shelf: toShelfView(ctx, shelfRow),
		book: await toBookView(db, ctx, bookRow),
		metadata,
		did: toDid(bs.did),
		createdAt: toIso(bs.createdAt),
		updatedAt: toIso(bs.updatedAt),
	};
}

export async function toShelfWithBooksView(
	db: Db,
	ctx: ViewContext,
	s: { pk: string; name: string; description: string | null; createdAt: number; updatedAt: number | null },
): Promise<ShelfWithBooksView> {
	const rows = db
		.select()
		.from(bookShelves)
		.where(eq(bookShelves.shelfPk, s.pk))
		.orderBy(sql`${bookShelves.position} is null, ${bookShelves.position} asc, ${bookShelves.createdAt} asc, ${bookShelves.pk} asc`)
		.all();
	const books: BookShelfView[] = [];
	for (const row of rows) books.push(await toBookShelfView(db, ctx, row));
	return { shelf: toShelfView(ctx, s), books };
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

export async function toReviewView(
	db: Db,
	ctx: ViewContext,
	r: {
		pk: string;
		bookPk: string;
		did: string;
		rating: number;
		status: string;
		text: string | null;
		progressFormatPk: string | null;
		progressValue: number | null;
		createdAt: number;
		updatedAt: number | null;
	},
): Promise<ReviewView> {
	const [bookRow, tags, _blobs, progressFormat] = await Promise.all([
		db.select().from(books).where(eq(books.pk, r.bookPk)).get(),
		db.select().from(reviewTags).where(eq(reviewTags.reviewPk, r.pk)).all(),
		db.select().from(reviewBlobs).where(eq(reviewBlobs.reviewPk, r.pk)).all(),
		r.progressFormatPk ? db.select().from(formats).where(eq(formats.pk, r.progressFormatPk)).get() : undefined,
	]);

	if (!bookRow) {
		throw new Error(`review ${r.pk} references missing book ${r.bookPk}`);
	}
	const book = await toBookView(db, ctx, bookRow);

	const progress: ReviewView['progress'] =
		r.progressValue != null || progressFormat
			? {
					format: progressFormat
						? {
								$type: 'net.olamaelcu.livtet.biblio.format',
								description: progressFormat.description,
								emoji: progressFormat.emoji,
								iconImageUrl: progressFormat.iconImageUrl
									? toUri(progressFormat.iconImageUrl)
									: undefined,
								unit: progressFormat.unit as Progress['format']['unit'],
							}
						: (r.progressFormatPk as unknown as Progress['format']),
					progress: r.progressValue ?? undefined,
					unit: progressFormat?.unit as Progress['unit'],
				}
			: undefined;

	void _blobs;

	return {
		uri: atUri(ctx, COLLECTION.review, r.pk) as ReviewView['uri'],
		book,
		did: toDid(r.did),
		tags: tags.map((t) => t.tag),
		rating: r.rating,
		status: r.status,
		progress,
		text: r.text ?? undefined,
		createdAt: toIso(r.createdAt),
		updatedAt: toIso(r.updatedAt),
	};
}
