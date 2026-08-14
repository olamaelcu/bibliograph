import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Bibliograph relational schema.
 *
 * Normalized (no JSON columns) model for an ATProto book/metadata PDS.
 * Every primary key is a `text` value: ATProto record keys (TIDs), ULIDs,
 * or lexical slugs. Timestamps are unix seconds (`integer`). Many-to-many
 * and identifier relationships live in dedicated join tables so that rows
 * can be referenced by foreign keys.
 */

export const works = sqliteTable(
	'works',
	{
		pk: text('pk').primaryKey(),
		title: text('title').notNull(),
		description: text('description'),
		originalPublishDate: integer('original_publish_date'),
		cid: text('cid').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at'),
	},
	(t) => ({
		titleIdx: index('works_title_idx').on(t.title),
	}),
);

export const authors = sqliteTable(
	'authors',
	{
		pk: text('pk').primaryKey(),
		name: text('name').notNull(),
		sortName: text('sort_name'),
		bio: text('bio'),
		imageUrl: text('image_url'),
		cid: text('cid').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at'),
	},
	(t) => ({
		nameIdx: index('authors_name_idx').on(t.name),
	}),
);

export const formats = sqliteTable('formats', {
	pk: text('pk').primaryKey(),
	description: text('description').notNull(),
	emoji: text('emoji').notNull(),
	iconImageUrl: text('icon_image_url'),
	unit: text('unit').notNull(),
	cid: text('cid').notNull().default(''),
});

export const genres = sqliteTable(
	'genres',
	{
		pk: text('pk').primaryKey(),
		name: text('name').notNull(),
		description: text('description').notNull(),
		emoji: text('emoji').notNull(),
		iconImageUrl: text('icon_image_url'),
		parentPk: text('parent_pk'),
		cid: text('cid').notNull().default(''),
		createdAt: integer('created_at').notNull(),
	},
	(t) => ({
		parentFk: foreignKey({ columns: [t.parentPk], foreignColumns: [t.pk] }).onDelete('set null'),
		nameIdx: index('genres_name_idx').on(t.name),
		parentPkIdx: index('genres_parent_pk_idx').on(t.parentPk),
	}),
);

export const contributorRoles = sqliteTable('contributor_roles', {
	pk: text('pk').primaryKey(),
	name: text('name').notNull(),
	description: text('description').notNull(),
	iconImageUrl: text('icon_image_url'),
	cid: text('cid').notNull().default(''),
	createdAt: integer('created_at').notNull(),
});

export const books = sqliteTable(
	'books',
	{
		pk: text('pk').primaryKey(),
		title: text('title').notNull(),
		workPk: text('work_pk').references(() => works.pk, { onDelete: 'set null' }),
		formatPk: text('format_pk').references(() => formats.pk, { onDelete: 'set null' }),
		publishDate: integer('publish_date'),
		description: text('description'),
		coverUrl: text('cover_url'),
		cid: text('cid').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at'),
	},
	(t) => ({
		workPkIdx: index('books_work_pk_idx').on(t.workPk),
		formatPkIdx: index('books_format_pk_idx').on(t.formatPk),
	}),
);

export const shelves = sqliteTable('shelves', {
	pk: text('pk').primaryKey(),
	name: text('name').notNull(),
	description: text('description'),
	iconImageCid: text('icon_image_cid'),
	headerImageCid: text('header_image_cid'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at'),
});

export const bookContributors = sqliteTable(
	'book_contributors',
	{
		bookPk: text('book_pk').notNull(),
		contributorPk: text('contributor_pk').notNull(),
		rolePk: text('role_pk').notNull(),
		createdAt: integer('created_at'),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.bookPk, t.contributorPk] }),
		bookFk: foreignKey({ columns: [t.bookPk], foreignColumns: [books.pk] }).onDelete('cascade'),
		contributorFk: foreignKey({
			columns: [t.contributorPk],
			foreignColumns: [authors.pk],
		}).onDelete('cascade'),
		roleFk: foreignKey({
			columns: [t.rolePk],
			foreignColumns: [contributorRoles.pk],
		}).onDelete('cascade'),
	}),
);

export const bookGenres = sqliteTable(
	'book_genres',
	{
		bookPk: text('book_pk').notNull(),
		genrePk: text('genre_pk').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.bookPk, t.genrePk] }),
		bookFk: foreignKey({ columns: [t.bookPk], foreignColumns: [books.pk] }).onDelete('cascade'),
		genreFk: foreignKey({ columns: [t.genrePk], foreignColumns: [genres.pk] }).onDelete('cascade'),
		genrePkIdx: index('book_genres_genre_pk_idx').on(t.genrePk),
	}),
);

export const genreChildren = sqliteTable(
	'genre_children',
	{
		parentPk: text('parent_pk').notNull(),
		childPk: text('child_pk').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.parentPk, t.childPk] }),
		parentFk: foreignKey({ columns: [t.parentPk], foreignColumns: [genres.pk] }).onDelete('cascade'),
		childFk: foreignKey({ columns: [t.childPk], foreignColumns: [genres.pk] }).onDelete('cascade'),
		childPkIdx: index('genre_children_child_pk_idx').on(t.childPk),
	}),
);

export const bookIdentifiers = sqliteTable(
	'book_identifiers',
	{
		bookPk: text('book_pk').notNull(),
		resource: text('resource').notNull(),
		url: text('url').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.bookPk, t.resource] }),
		bookFk: foreignKey({ columns: [t.bookPk], foreignColumns: [books.pk] }).onDelete('cascade'),
		urlIdx: index('book_identifiers_url_idx').on(t.url),
	}),
);

export const workIdentifiers = sqliteTable(
	'work_identifiers',
	{
		workPk: text('work_pk').notNull(),
		resource: text('resource').notNull(),
		url: text('url').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.workPk, t.resource] }),
		workFk: foreignKey({ columns: [t.workPk], foreignColumns: [works.pk] }).onDelete('cascade'),
		urlIdx: index('work_identifiers_url_idx').on(t.url),
	}),
);

export const authorIdentifiers = sqliteTable(
	'author_identifiers',
	{
		authorPk: text('author_pk').notNull(),
		resource: text('resource').notNull(),
		url: text('url').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.authorPk, t.resource] }),
		authorFk: foreignKey({ columns: [t.authorPk], foreignColumns: [authors.pk] }).onDelete('cascade'),
		urlIdx: index('author_identifiers_url_idx').on(t.url),
	}),
);

export const genreIdentifiers = sqliteTable(
	'genre_identifiers',
	{
		genrePk: text('genre_pk').notNull(),
		resource: text('resource').notNull(),
		url: text('url').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.genrePk, t.resource] }),
		genreFk: foreignKey({ columns: [t.genrePk], foreignColumns: [genres.pk] }).onDelete('cascade'),
		urlIdx: index('genre_identifiers_url_idx').on(t.url),
	}),
);

// ─── Reviews ────────────────────────────────────────────────────────────────

export const reviewStatuses = ['reading', 'to-read', 'dnf', 'read'] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];

export const reviews = sqliteTable(
	'reviews',
	{
		pk: text('pk').primaryKey(),
		bookPk: text('book_pk')
			.notNull()
			.references(() => books.pk, { onDelete: 'cascade' }),
		did: text('did').notNull(),
		rating: integer('rating').notNull(),
		status: text('status').notNull(),
		text: text('text'),
		progressFormatPk: text('progress_format_pk').references(() => formats.pk, {
			onDelete: 'set null',
		}),
		progressValue: integer('progress_value'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at'),
	},
	(t) => ({
		bookPkIdx: index('reviews_book_pk_idx').on(t.bookPk),
		didIdx: index('reviews_did_idx').on(t.did),
		statusIdx: index('reviews_status_idx').on(t.status),
		ratingIdx: index('reviews_rating_idx').on(t.rating),
		progressFormatPkIdx: index('reviews_progress_format_pk_idx').on(t.progressFormatPk),
		ratingCheck: check(
			'reviews_rating_check',
			sql`${t.rating} >= 1 AND ${t.rating} <= 5`,
		),
		statusCheck: check(
			'reviews_status_check',
			sql`${t.status} IN ('reading', 'to-read', 'dnf', 'read')`,
		),
	}),
);

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;

export const reviewTags = sqliteTable(
	'review_tags',
	{
		reviewPk: text('review_pk').notNull(),
		tag: text('tag').notNull(),
		createdAt: integer('created_at'),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.reviewPk, t.tag] }),
		reviewFk: foreignKey({
			columns: [t.reviewPk],
			foreignColumns: [reviews.pk],
		}).onDelete('cascade'),
		tagIdx: index('review_tags_tag_idx').on(t.tag),
	}),
);

export type ReviewTag = typeof reviewTags.$inferSelect;
export type NewReviewTag = typeof reviewTags.$inferInsert;

export const reviewBlobs = sqliteTable(
	'review_blobs',
	{
		pk: text('pk').primaryKey(),
		reviewPk: text('review_pk')
			.notNull()
			.references(() => reviews.pk, { onDelete: 'cascade' }),
		type: text('type').notNull(),
		cid: text('cid').notNull(),
		mimeType: text('mime_type'),
		size: integer('size'),
		cacheKey: text('cache_key'),
		createdAt: integer('created_at').notNull(),
	},
	(t) => ({
		reviewPkIdx: index('review_blobs_review_pk_idx').on(t.reviewPk),
		typeIdx: index('review_blobs_type_idx').on(t.type),
		cidIdx: index('review_blobs_cid_idx').on(t.cid),
	}),
);

export type ReviewBlob = typeof reviewBlobs.$inferSelect;
export type NewReviewBlob = typeof reviewBlobs.$inferInsert;

// ─── Book Shelving ───────────────────────────────────────────────────────────

export const bookShelves = sqliteTable(
	'book_shelves',
	{
		pk: text('pk').primaryKey(),
		did: text('did').notNull(),
		bookPk: text('book_pk')
			.notNull()
			.references(() => books.pk, { onDelete: 'cascade' }),
		shelfPk: text('shelf_pk')
			.notNull()
			.references(() => shelves.pk, { onDelete: 'cascade' }),
		position: integer('position'),
		notes: text('notes'),
		emoji: text('emoji'),
		status: text('status').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at'),
	},
	(t) => ({
		didIdx: index('book_shelves_did_idx').on(t.did),
		bookPkIdx: index('book_shelves_book_pk_idx').on(t.bookPk),
		shelfPkIdx: index('book_shelves_shelf_pk_idx').on(t.shelfPk),
		statusIdx: index('book_shelves_status_idx').on(t.status),
		uniqueBookShelf: uniqueIndex('book_shelves_unique_idx').on(t.bookPk, t.shelfPk),
		positionCheck: check(
			'book_shelves_position_check',
			sql`${t.position} IS NULL OR ${t.position} >= 1`,
		),
		statusCheck: check(
			'book_shelves_status_check',
			sql`${t.status} IN ('reading', 'to-read', 'dnf', 'read')`,
		),
	}),
);

export type BookShelf = typeof bookShelves.$inferSelect;
export type NewBookShelf = typeof bookShelves.$inferInsert;
