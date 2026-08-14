import { and, eq, gte, inArray, like, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { XRPCRouter, json, InvalidRequestError, XRPCError } from '@atcute/xrpc-server';
import * as Lexicons from '../lexicons/index.js';
import { registerPdsHandlers } from '../pds/router.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
	COLLECTION,
	toBookShelfView,
	toBookView,
	toContributorView,
	toGenreView,
	toReviewView,
	toShelfView,
	toShelfWithBooksView,
	toWorkView,
	type ViewContext,
} from './views.js';
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
	reviews,
	reviewTags,
	shelves,
	workIdentifiers,
	works,
} from '../db/schema.js';

type Db = BetterSQLite3Database;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
	if (limit == null) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, limit));
}

function notFound() {
	throw new XRPCError({ status: 404, error: 'NotFound', message: 'record not found' });
}

/** Extract the record key (rkey) segment from an at-uri for our own collection. */
function rkeyFromUri(ctx: ViewContext, collection: string, uri: string): string {
	const prefix = `at://${ctx.serviceDid}/${collection}/`;
	if (!uri.startsWith(prefix)) {
		throw new InvalidRequestError({
			status: 400,
			error: 'InvalidRequest',
			message: 'uri must reference a record hosted by this service',
		});
	}
	const rkey = uri.slice(prefix.length);
	if (!rkey || rkey.includes('/')) {
		throw new InvalidRequestError({ status: 400, error: 'InvalidRequest', message: 'invalid record uri' });
	}
	return rkey;
}

export function createXrpcRouter(db: Db, ctx: ViewContext): XRPCRouter {
	const router = new XRPCRouter();
	registerPdsHandlers(router, db, ctx);

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBook.mainSchema, {
		async handler({ params }) {
			const rkey = rkeyFromUri(ctx, COLLECTION.book, params.uri);
			const row = db.select().from(books).where(eq(books.pk, rkey)).get();
			if (!row) notFound();
			return json({ book: await toBookView(db, ctx, row!) });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetWork.mainSchema, {
		async handler({ params }) {
			const rkey = rkeyFromUri(ctx, COLLECTION.work, params.uri);
			const row = db.select().from(works).where(eq(works.pk, rkey)).get();
			if (!row) notFound();
			const identifiers = db
				.select()
				.from(workIdentifiers)
				.where(eq(workIdentifiers.workPk, rkey))
				.all();
			return json({ work: toWorkView(ctx, row!, identifiers) });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetContributor.mainSchema, {
		async handler({ params }) {
			const rkey = rkeyFromUri(ctx, COLLECTION.contributor, params.uri);
			const row = db.select().from(contributors).where(eq(contributors.pk, rkey)).get();
			if (!row) notFound();
			const identifiers = db
				.select()
				.from(contributorIdentifiers)
				.where(eq(contributorIdentifiers.contributorPk, rkey))
				.all();
			return json({ contributor: toContributorView(ctx, row!, identifiers) });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetReview.mainSchema, {
		async handler({ params }) {
			const rkey = rkeyFromUri(ctx, COLLECTION.review, params.uri);
			const row = db.select().from(reviews).where(eq(reviews.pk, rkey)).get();
			if (!row) notFound();
			return json({ review: await toReviewView(db, ctx, row!) });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelf.mainSchema, {
		async handler({ params }) {
			const rkey = rkeyFromUri(ctx, COLLECTION.shelf, params.uri);
			const row = db.select().from(shelves).where(eq(shelves.pk, rkey)).get();
			if (!row) notFound();
			return json({ shelf: toShelfView(ctx, row!) });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetGenre.mainSchema, {
		async handler({ params }) {
			const rkey = rkeyFromUri(ctx, COLLECTION.genre, params.uri);
			const row = db.select().from(genres).where(eq(genres.pk, rkey)).get();
			if (!row) notFound();
			const identifiers = db
				.select()
				.from(genreIdentifiers)
				.where(eq(genreIdentifiers.genrePk, rkey))
				.all();
			return json({ genre: toGenreView(ctx, row!, identifiers) });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooks.mainSchema, {
		async handler({ params }) {
			const limit = clampLimit(params.limit);
			const filters = [];
			if (params.genre) {
				const genrePk = rkeyFromUri(ctx, COLLECTION.genre, params.genre);
				const sub = db
					.select({ bookPk: bookGenres.bookPk })
					.from(bookGenres)
					.where(eq(bookGenres.genrePk, genrePk));
				filters.push(sql`${books.pk} in (${sub})`);
			}
			if (params.format) {
				const formatPk = rkeyFromUri(ctx, COLLECTION.format, params.format);
				filters.push(eq(books.formatPk, formatPk));
			}
			if (params.status) {
				const sub = db
					.select({ bookPk: reviews.bookPk })
					.from(reviews)
					.where(eq(reviews.status, params.status));
				filters.push(sql`${books.pk} in (${sub})`);
			}
			const where = filters.length ? and(...filters) : undefined;
			const rows = db
				.select()
				.from(books)
				.where(where)
				.orderBy(sql`${books.title} asc, ${books.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const views = [];
			for (const row of page) views.push(await toBookView(db, ctx, row));
			const last = page.at(-1);
			return json({
				books: views,
				cursor: hasMore && last ? encodeCursor({ key: last.title, pk: last.pk }) : undefined,
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListReviewsByBook.mainSchema, {
		async handler({ params }) {
			const bookPk = rkeyFromUri(ctx, COLLECTION.book, params.book);
			const bookExists = db.select().from(books).where(eq(books.pk, bookPk)).get();
			if (!bookExists) notFound();
			const limit = clampLimit(params.limit);
			const rows = db
				.select()
				.from(reviews)
				.where(eq(reviews.bookPk, bookPk))
				.orderBy(sql`${reviews.createdAt} asc, ${reviews.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const views = [];
			for (const row of page) views.push(await toReviewView(db, ctx, row));
			const last = page.at(-1);
			return json({
				reviews: views,
				cursor:
					hasMore && last ? encodeCursor({ key: String(last.createdAt), pk: last.pk }) : undefined,
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelves.mainSchema, {
		async handler({ params }) {
			const limit = clampLimit(params.limit);
			const rows = db
				.select()
				.from(shelves)
				.orderBy(sql`${shelves.name} asc, ${shelves.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const last = page.at(-1);
			return json({
				shelves: page.map((row) => toShelfView(ctx, row)),
				cursor: hasMore && last ? encodeCursor({ key: last.name, pk: last.pk }) : undefined,
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetBookOnShelf.mainSchema, {
		async handler({ params }) {
			const rkey = rkeyFromUri(ctx, COLLECTION.bookShelf, params.uri);
			const row = db.select().from(bookShelves).where(eq(bookShelves.pk, rkey)).get();
			if (!row) notFound();
			return json({ bookShelf: await toBookShelfView(db, ctx, row!) });
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioGetShelvingOfBook.mainSchema, {
		async handler({ params }) {
			const bookPk = rkeyFromUri(ctx, COLLECTION.book, params.book);
			const bookExists = db.select().from(books).where(eq(books.pk, bookPk)).get();
			if (!bookExists) notFound();
			const limit = clampLimit(params.limit);
			const rows = db
				.select()
				.from(bookShelves)
				.where(eq(bookShelves.bookPk, bookPk))
				.orderBy(sql`${bookShelves.createdAt} asc, ${bookShelves.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const views = [];
			for (const row of page) views.push(await toBookShelfView(db, ctx, row));
			const last = page.at(-1);
			return json({
				bookShelves: views,
				cursor:
					hasMore && last ? encodeCursor({ key: String(last.createdAt), pk: last.pk }) : undefined,
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListBooksOnShelf.mainSchema, {
		async handler({ params }) {
			const shelfPk = rkeyFromUri(ctx, COLLECTION.shelf, params.shelf);
			const shelfExists = db.select().from(shelves).where(eq(shelves.pk, shelfPk)).get();
			if (!shelfExists) notFound();
			const limit = clampLimit(params.limit);
			const rows = db
				.select()
				.from(bookShelves)
				.where(eq(bookShelves.shelfPk, shelfPk))
				.orderBy(sql`${bookShelves.position} is null, ${bookShelves.position} asc, ${bookShelves.createdAt} asc, ${bookShelves.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const views = [];
			for (const row of page) views.push(await toBookShelfView(db, ctx, row));
			const last = page.at(-1);
			return json({
				bookShelves: views,
				cursor:
					hasMore && last ? encodeCursor({ key: String(last.createdAt), pk: last.pk }) : undefined,
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListShelvesWithBooks.mainSchema, {
		async handler({ params }) {
			const limit = clampLimit(params.limit);
			const rows = db
				.select()
				.from(shelves)
				.orderBy(sql`${shelves.name} asc, ${shelves.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const views = [];
			for (const row of page) views.push(await toShelfWithBooksView(db, ctx, row));
			const last = page.at(-1);
			return json({
				shelves: views,
				cursor: hasMore && last ? encodeCursor({ key: last.name, pk: last.pk }) : undefined,
			});		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioListGenres.mainSchema, {
		async handler({ params }) {
			const limit = clampLimit(params.limit);
			const conds = params.topLevelOnly ? [sql`${genres.parentPk} is null`] : [];
			const rows = db
				.select()
				.from(genres)
				.where(conds.length ? and(...conds) : undefined)
				.orderBy(sql`${genres.name} asc, ${genres.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const pks = page.map((g) => g.pk);
			const idRows: { genrePk: string; resource: string; url: string }[] = pks.length
				? db
						.select()
						.from(genreIdentifiers)
						.where(inArray(genreIdentifiers.genrePk, pks))
						.all()
				: [];
			const idByGenre = new Map<string, { genrePk: string; resource: string; url: string }[]>();
			for (const row of idRows) {
				const list = idByGenre.get(row.genrePk) ?? [];
				list.push(row);
				idByGenre.set(row.genrePk, list);
			}
			const last = page.at(-1);
			return json({
				genres: page.map((g) => toGenreView(ctx, g, idByGenre.get(g.pk) ?? [])),
				cursor: hasMore && last ? encodeCursor({ key: last.name, pk: last.pk }) : undefined,
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchBooks.mainSchema, {
		async handler({ params }) {
			const q = params.q.trim();
			const limit = clampLimit(params.limit);
			const term = `%${q}%`;
			const idSub = db
				.select({ bookPk: bookIdentifiers.bookPk })
				.from(bookIdentifiers)
				.where(like(bookIdentifiers.resource, term));
			const where = or(
				like(books.title, term),
				like(books.description, term),
				sql`${books.pk} in (${idSub})`,
			);
			const rows = db
				.select()
				.from(books)
				.where(where)
				.orderBy(sql`${books.title} asc, ${books.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const views = [];
			for (const row of page) views.push(await toBookView(db, ctx, row));
			const hitsTotal = db.select({ count: sql`count(*)` }).from(books).where(where).get();
			const last = page.at(-1);
			return json({
				books: views,
				hitsTotal: Number(hitsTotal?.count ?? 0),
				cursor: hasMore && last ? encodeCursor({ key: last.title, pk: last.pk }) : undefined,
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchContributors.mainSchema, {
		async handler({ params }) {
			const q = params.q.trim();
			const limit = clampLimit(params.limit);
			const term = `%${q}%`;
			const filters = [
				or(like(contributors.name, term), like(contributors.sortName, term), like(contributors.bio, term)),
			];
			if (params.role) {
				const rolePk = rkeyFromUri(ctx, COLLECTION.contributorRole, params.role);
				const sub = db
					.select({ contributorPk: bookContributors.contributorPk })
					.from(bookContributors)
					.where(eq(bookContributors.rolePk, rolePk));
				filters.push(sql`${contributors.pk} in (${sub})`);
			}
			const where = and(...filters);
			const rows = db
				.select()
				.from(contributors)
				.where(where)
				.orderBy(sql`${contributors.name} asc, ${contributors.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const pks = page.map((a) => a.pk);
			const idRows: { contributorPk: string; resource: string; url: string }[] = pks.length
				? db
						.select()
						.from(contributorIdentifiers)
						.where(inArray(contributorIdentifiers.contributorPk, pks))
						.all()
				: [];
			const idByContributor = new Map<string, { contributorPk: string; resource: string; url: string }[]>();
			for (const row of idRows) {
				const list = idByContributor.get(row.contributorPk) ?? [];
				list.push(row);
				idByContributor.set(row.contributorPk, list);
			}
			const hitsTotal = db.select({ count: sql`count(*)` }).from(contributors).where(where).get();
			const last = page.at(-1);
			return json({
				contributors: page.map((a) => toContributorView(ctx, a, idByContributor.get(a.pk) ?? [])),
				hitsTotal: Number(hitsTotal?.count ?? 0),
				cursor: hasMore && last ? encodeCursor({ key: last.name, pk: last.pk }) : undefined,
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchReviews.mainSchema, {
		async handler({ params }) {
			const q = params.q.trim();
			const limit = clampLimit(params.limit);
			const term = `%${q}%`;
			const tagSub = db
				.select({ reviewPk: reviewTags.reviewPk })
				.from(reviewTags)
				.where(like(reviewTags.tag, term));
			const filters = [or(like(reviews.text, term), sql`${reviews.pk} in (${tagSub})`)];
			if (params.book) {
				const bookPk = rkeyFromUri(ctx, COLLECTION.book, params.book);
				filters.push(eq(reviews.bookPk, bookPk));
			}
			if (params.rating != null) {
				filters.push(gte(reviews.rating, params.rating));
			}
			if (params.status) {
				filters.push(eq(reviews.status, params.status));
			}
			if (params.tag?.length) {
				const sub = db
					.select({ reviewPk: reviewTags.reviewPk })
					.from(reviewTags)
					.where(inArray(reviewTags.tag, params.tag));
				filters.push(sql`${reviews.pk} in (${sub})`);
			}
			const where = and(...filters);
			const rows = db
				.select()
				.from(reviews)
				.where(where)
				.orderBy(sql`${reviews.createdAt} asc, ${reviews.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const views = [];
			for (const row of page) views.push(await toReviewView(db, ctx, row));
			const hitsTotal = db.select({ count: sql`count(*)` }).from(reviews).where(where).get();
			const last = page.at(-1);
			return json({
				reviews: views,
				hitsTotal: Number(hitsTotal?.count ?? 0),
				cursor:
					hasMore && last ? encodeCursor({ key: String(last.createdAt), pk: last.pk }) : undefined,
			});
		},
	});

	router.addQuery(Lexicons.NetOlamaelcuLivtetBiblioSearchWorks.mainSchema, {
		async handler({ params }) {
			const q = params.q.trim();
			const limit = clampLimit(params.limit);
			const term = `%${q}%`;
			const idSub = db
				.select({ workPk: workIdentifiers.workPk })
				.from(workIdentifiers)
				.where(like(workIdentifiers.resource, term));
			const where = or(
				like(works.title, term),
				like(works.description, term),
				sql`${works.pk} in (${idSub})`,
			);
			const rows = db
				.select()
				.from(works)
				.where(where)
				.orderBy(sql`${works.title} asc, ${works.pk} asc`)
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const page = hasMore ? rows.slice(0, limit) : rows;
			const pks = page.map((w) => w.pk);
			const idRows: { workPk: string; resource: string; url: string }[] = pks.length
				? db
						.select()
						.from(workIdentifiers)
						.where(inArray(workIdentifiers.workPk, pks))
						.all()
				: [];
			const idByWork = new Map<string, { workPk: string; resource: string; url: string }[]>();
			for (const row of idRows) {
				const list = idByWork.get(row.workPk) ?? [];
				list.push(row);
				idByWork.set(row.workPk, list);
			}
			const hitsTotal = db.select({ count: sql`count(*)` }).from(works).where(where).get();
			const last = page.at(-1);
			return json({
				works: page.map((w) => toWorkView(ctx, w, idByWork.get(w.pk) ?? [])),
				hitsTotal: Number(hitsTotal?.count ?? 0),
				cursor: hasMore && last ? encodeCursor({ key: last.title, pk: last.pk }) : undefined,
			});
		},
	});

	return router;
}
