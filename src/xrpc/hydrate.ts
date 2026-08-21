import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import {
	bookContributors,
	bookGenres,
	bookIdentifiers,
	books,
	contributorIdentifiers,
	contributors,
	contributorRoles,
	formats,
	genreIdentifiers,
	genres,
} from '../db/schema.js';
import { releasedFilter } from './gate.js';
import { getEngagementForSubject } from '../network/constellation.js';
import type { PdsRecord, ViewContext } from '../lex/collections.js';
import { COLLECTION } from '../lex/collections.js';
import type {
	ActorView,
	BookContributorView,
	BookShelfView,
	BookView,
	ContributorView,
	ExpandedBook,
	ExpandedContributor,
	FormatView,
	GenreView,
	Identifier,
	ShelfView,
	ShelfWithBooksView,
} from '../lexicons/types/net/olamaelcu/livtet/biblio/defs.js';

type Db = NodePgDatabase<typeof schema>;

export interface IdentifierRow {
	resource: string;
	url: string;
}

function asUri(value: string): `${string}:${string}` {
	return value as `${string}:${string}`;
}

function asDid(value: string): `did:${string}:${string}` {
	return value as `did:${string}:${string}`;
}

/** Build the canonical at-uri for a service-owned record. */
function recordUri(ctx: ViewContext, collection: string, rkey: string): string {
	return `at://${ctx.serviceDid}/${collection}/${rkey}`;
}

function toIdentifiers(rows: IdentifierRow[]): Identifier[] {
	return rows.map((r) => ({ resource: r.resource, url: asUri(r.url) }));
}

export async function loadIdentifiers(
	db: Db,
	table: typeof contributorIdentifiers | typeof genreIdentifiers | typeof bookIdentifiers,
	pkCol:
		| typeof contributorIdentifiers.contributorPk
		| typeof genreIdentifiers.genrePk
		| typeof bookIdentifiers.bookPk,
	pk: string,
): Promise<IdentifierRow[]> {
	const rows = (await db.select().from(table).where(eq(pkCol, pk))) as IdentifierRow[];
	return rows;
}

/** Attach bsky iff constellation returns non-zero counts. */
async function attachBsky<T extends object>(
	uri: string,
	view: T,
): Promise<T> {
	const bsky = await getEngagementForSubject(uri);
	if (bsky && (bsky.likeCount > 0 || bsky.quoteCount > 0)) {
		(view as { bsky?: { likeCount: number; quoteCount: number } }).bsky = {
			likeCount: bsky.likeCount,
			quoteCount: bsky.quoteCount,
		};
	}
	return view;
}

// ─── format ─────────────────────────────────────────────────────────────────

export function toFormatView(
	ctx: ViewContext,
	row: {
		pk: string;
		description: string;
		emoji: string;
		iconImageUrl: string | null;
		unit: string;
	},
): FormatView {
	const v: FormatView = {
		uri: recordUri(ctx, COLLECTION.format, row.pk) as FormatView['uri'],
		description: row.description,
		emoji: row.emoji,
		unit: row.unit,
	};
	if (row.iconImageUrl) v.iconImageUrl = asUri(row.iconImageUrl);
	return v;
}

// ─── contributor ────────────────────────────────────────────────────────────

export async function toContributorView(
	db: Db,
	ctx: ViewContext,
	row: {
		pk: string;
		name: string;
		sortName: string | null;
		bio: string | null;
		imageUrl: string | null;
		createdAt: number;
		updatedAt: number | null;
	},
): Promise<ContributorView> {
	const uri = recordUri(ctx, COLLECTION.contributor, row.pk) as ContributorView['uri'];
	const identifiers = await loadIdentifiers(
		db,
		contributorIdentifiers,
		contributorIdentifiers.contributorPk,
		row.pk,
	);
	const v: ContributorView = {
		uri,
		name: row.name,
		identifiers: toIdentifiers(identifiers),
		createdAt: new Date(row.createdAt * 1000).toISOString(),
	};
	if (row.sortName) v.sortName = row.sortName;
	if (row.bio) v.bio = row.bio;
	if (row.imageUrl) v.imageUrl = asUri(row.imageUrl);
	if (row.updatedAt != null) v.updatedAt = new Date(row.updatedAt * 1000).toISOString();
	return attachBsky(uri, v);
}

// ─── genre ──────────────────────────────────────────────────────────────────

export async function toGenreView(
	db: Db,
	ctx: ViewContext,
	row: {
		pk: string;
		name: string;
		description: string;
		emoji: string;
		iconImageUrl: string | null;
		parentPk: string | null;
	},
): Promise<GenreView> {
	const uri = recordUri(ctx, COLLECTION.genre, row.pk) as GenreView['uri'];
	const identifiers = await loadIdentifiers(
		db,
		genreIdentifiers,
		genreIdentifiers.genrePk,
		row.pk,
	);
	const v: GenreView = {
		uri,
		name: row.name,
		description: row.description,
		emoji: row.emoji,
		identifiers: toIdentifiers(identifiers),
	};
	if (row.iconImageUrl) v.iconImageUrl = asUri(row.iconImageUrl);
	if (row.parentPk) {
		v.parent = recordUri(ctx, COLLECTION.genre, row.parentPk) as GenreView['parent'];
	}
	return attachBsky(uri, v);
}

// ─── book ────────────────────────────────────────────────────────────────────

export async function toBookView(
	db: Db,
	ctx: ViewContext,
	row: {
		pk: string;
		title: string;
		formatPk: string | null;
		publishDate: number | null;
		description: string | null;
		coverUrl: string | null;
		createdAt: number;
		updatedAt: number | null;
	},
): Promise<BookView> {
	const uri = recordUri(ctx, COLLECTION.book, row.pk) as BookView['uri'];

	const [formatRow, genreJoinRows, contributorJoinRows, bookIdentifierRows] = await Promise.all([
		row.formatPk
			? db.select().from(formats).where(eq(formats.pk, row.formatPk)).then((rs) => rs[0])
			: Promise.resolve(undefined),
		db
			.select({ genre: genres })
			.from(bookGenres)
			.innerJoin(genres, eq(bookGenres.genrePk, genres.pk))
			.where(and(eq(bookGenres.bookPk, row.pk), releasedFilter(genres))),
		db
			.select({ contributor: contributors, role: contributorRoles })
			.from(bookContributors)
			.innerJoin(contributors, eq(bookContributors.contributorPk, contributors.pk))
			.innerJoin(contributorRoles, eq(bookContributors.rolePk, contributorRoles.pk))
			.where(and(eq(bookContributors.bookPk, row.pk), releasedFilter(contributors))),
		loadIdentifiers(db, bookIdentifiers, bookIdentifiers.bookPk, row.pk),
	]);

	const contributorPks = contributorJoinRows.map((r) => r.contributor.pk);
	const genrePks = genreJoinRows.map((r) => r.genre.pk);
	const [genreRows, contributorRows, identifierRows] = await Promise.all([
		genrePks.length
			? db.select().from(genres).where(inArray(genres.pk, genrePks))
			: Promise.resolve([]),
		contributorPks.length
			? db
					.select({ contributor: contributors, ids: contributorIdentifiers })
					.from(contributors)
					.leftJoin(
						contributorIdentifiers,
						eq(contributorIdentifiers.contributorPk, contributors.pk),
					)
					.where(inArray(contributors.pk, contributorPks))
			: Promise.resolve([] as Array<{ contributor: typeof contributors.$inferSelect; ids: typeof contributorIdentifiers.$inferSelect | null }>),
		loadIdentifiers(db, bookIdentifiers, bookIdentifiers.bookPk, row.pk),
	]);

	const contributorInfoByPk = new Map<string, typeof contributors.$inferSelect>();
	const identifiersByPk = new Map<string, IdentifierRow[]>();
	for (const row of contributorRows) {
		contributorInfoByPk.set(row.contributor.pk, row.contributor);
		if (row.ids) {
			const list = identifiersByPk.get(row.contributor.pk) ?? [];
			list.push(row.ids);
			identifiersByPk.set(row.contributor.pk, list);
		}
	}

	const contributorsView: BookContributorView[] = contributorJoinRows.map((bc) => {
		const c = contributorInfoByPk.get(bc.contributor.pk);
		if (!c) throw new Error(`contributor ${bc.contributor.pk} missing from join result`);
		const cUri = recordUri(ctx, COLLECTION.contributor, bc.contributor.pk) as ContributorView['uri'];
		const contributorView: ContributorView = {
			uri: cUri,
			name: c.name,
			identifiers: toIdentifiers(identifiersByPk.get(bc.contributor.pk) ?? []),
			createdAt: new Date(c.createdAt * 1000).toISOString(),
		};
		if (c.sortName) contributorView.sortName = c.sortName;
		if (c.bio) contributorView.bio = c.bio;
		if (c.imageUrl) contributorView.imageUrl = asUri(c.imageUrl);
		if (c.updatedAt != null) contributorView.updatedAt = new Date(c.updatedAt * 1000).toISOString();
		return {
			bookUri: uri,
			contributor: contributorView,
			role: recordUri(ctx, COLLECTION.contributorRole, bc.role.pk) as BookContributorView['role'],
		};
	});

	const genreViews = genreRows.map<GenreView>((g) => ({
		uri: recordUri(ctx, COLLECTION.genre, g.pk) as GenreView['uri'],
		name: g.name,
		description: g.description,
		emoji: g.emoji,
		identifiers: [],
	}));

	const v: BookView = {
		uri,
		title: row.title,
		genres: genreViews,
		contributors: contributorsView,
		identifiers: toIdentifiers(identifierRows),
	};
	if (formatRow) v.format = toFormatView(ctx, formatRow);
	if (row.publishDate != null) v.publishDate = new Date(row.publishDate * 1000).toISOString();
	if (row.description) v.description = row.description;
	if (row.coverUrl) v.coverUrl = asUri(row.coverUrl);
	v.createdAt = new Date(row.createdAt * 1000).toISOString();
	if (row.updatedAt != null) v.updatedAt = new Date(row.updatedAt * 1000).toISOString();
	return attachBsky(uri, v);
}

// ─── expandedBook (used for embedded bookShelving.book ref) ─────────────────

export async function toExpandedBook(
	db: Db,
	ctx: ViewContext,
	row: { pk: string; title: string; coverUrl: string | null },
): Promise<ExpandedBook> {
	const [identifierRows, contributorJoinRows] = await Promise.all([
		loadIdentifiers(db, bookIdentifiers, bookIdentifiers.bookPk, row.pk),
		db
			.select({ contributor: contributors, role: contributorRoles })
			.from(bookContributors)
			.innerJoin(contributors, eq(bookContributors.contributorPk, contributors.pk))
			.innerJoin(contributorRoles, eq(bookContributors.rolePk, contributorRoles.pk))
			.where(eq(bookContributors.bookPk, row.pk)),
	]);

	const expandedContributors: ExpandedContributor[] = contributorJoinRows.map((r) => {
		const c: ExpandedContributor = {
			name: r.contributor.name,
			role: recordUri(ctx, COLLECTION.contributorRole, r.role.pk) as ExpandedContributor['role'],
		};
		if (r.contributor.sortName) c.sortName = r.contributor.sortName;
		if (r.contributor.bio) c.bio = r.contributor.bio;
		if (r.contributor.imageUrl) c.imageUrl = asUri(r.contributor.imageUrl);
		return c;
	});

	const ref = recordUri(ctx, COLLECTION.book, row.pk) as ExpandedBook['ref'];
	const v: ExpandedBook = {
		ref,
		title: row.title,
		contributors: expandedContributors,
		identifiers: toIdentifiers(identifierRows),
	};
	if (row.coverUrl) v.coverImageUrl = asUri(row.coverUrl);
	return v;
}

/** Look up a book by its local-canonical at-uri rkey and hydrate a BookView. */
export async function hydrateBook(
	db: Db,
	ctx: ViewContext,
	bookUri: string,
): Promise<BookView | undefined> {
	const m = bookUri.match(/^at:\/\/[^/]+\/([^/]+)\/([^/]+)$/);
	if (!m) return undefined;
	const rkey = m[2];
	const row = (await db
		.select()
		.from(books)
		.where(and(eq(books.pk, rkey), releasedFilter(books))))[0];
	if (!row) return undefined;
	return toBookView(db, ctx, row);
}

// ─── shelves / actors / bookShelving (from user_records) ────────────────────

export function toShelfView(rec: PdsRecord): ShelfView {
	const value = rec.value as { name: string; description?: string; createdAt?: string };
	const v: ShelfView = {
		uri: rec.uri as ShelfView['uri'],
		name: value.name,
	};
	if (value.description) v.description = value.description;
	if (value.createdAt) v.createdAt = value.createdAt;
	return v;
}

export async function withShelfBsky(view: ShelfView): Promise<ShelfView> {
	return attachBsky(view.uri, view);
}

export function toActorView(rec: PdsRecord | undefined, did: string): ActorView {
	const v: ActorView = { did: asDid(did) };
	if (rec?.value && typeof rec.value === 'object') {
		const value = rec.value as { displayName?: string; description?: string };
		if (value.displayName) v.displayName = value.displayName;
		if (value.description) v.description = value.description;
	}
	return v;
}

export async function withActorBsky(view: ActorView): Promise<ActorView> {
	return attachBsky(view.did, view);
}

export function toBookShelfView(
	rec: PdsRecord,
	did: string,
	shelf: ShelfView,
	book: BookView,
): BookShelfView {
	const value = rec.value as {
		metadata?: { status?: string; position?: number; notes?: string; emoji?: string };
		createdAt?: string;
	};
	const metadata: BookShelfView['metadata'] = {
		status: (value.metadata?.status ?? 'to-read') as BookShelfView['metadata']['status'],
	};
	if (value.metadata?.position != null) metadata.position = value.metadata.position;
	if (value.metadata?.notes) metadata.notes = value.metadata.notes;
	if (value.metadata?.emoji) metadata.emoji = value.metadata.emoji;
	const v: BookShelfView = {
		uri: rec.uri as BookShelfView['uri'],
		shelf,
		book,
		metadata,
		did: asDid(did),
	};
	if (value.createdAt) v.createdAt = value.createdAt;
	return v;
}

export function toShelfWithBooksView(shelf: ShelfView, books: BookShelfView[]): ShelfWithBooksView {
	return { shelf, books };
}