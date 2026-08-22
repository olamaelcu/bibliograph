import { sql } from 'drizzle-orm';
import {
	bigint,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Bibliograph relational schema.
 *
 * Owned record tables back the PDS (com.atproto.repo.{getRecord,listRecords}).
 * Reads served over the AppView's net.olamaelcu.livtet.biblio.* XRPC are now
 * backed by Google Books (see src/google-books/) and no longer touch these
 * tables — only the PDS write/read paths do.
 *
 * Every primary key is a `text` value: ATProto record keys (TIDs), ULIDs,
 * or lexical slugs. Timestamps are unix seconds (`integer`). Many-to-many
 * and identifier relationships live in dedicated join tables so that rows
 * can be referenced by foreign keys.
 */

export const contributors = pgTable('contributors', {
	pk: text('pk').primaryKey(),
	name: text('name').notNull(),
	sortName: text('sort_name'),
	bio: text('bio'),
	imageUrl: text('image_url'),
	cid: text('cid').notNull().default(''),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at'),
});

export const formats = pgTable('formats', {
	pk: text('pk').primaryKey(),
	description: text('description').notNull(),
	emoji: text('emoji').notNull(),
	iconImageUrl: text('icon_image_url'),
	unit: text('unit').notNull(),
	cid: text('cid').notNull().default(''),
});

export const genres = pgTable(
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

export const contributorRoles = pgTable('contributor_roles', {
	pk: text('pk').primaryKey(),
	name: text('name').notNull(),
	description: text('description').notNull(),
	iconImageUrl: text('icon_image_url'),
	cid: text('cid').notNull().default(''),
	createdAt: integer('created_at').notNull(),
});

export const books = pgTable(
	'books',
	{
		pk: text('pk').primaryKey(),
		title: text('title').notNull(),
		formatPk: text('format_pk').references(() => formats.pk, { onDelete: 'set null' }),
		publishDate: bigint('publish_date', { mode: 'number' }),
		description: text('description'),
		coverUrl: text('cover_url'),
		cid: text('cid').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at'),
	},
	(t) => ({
		formatPkIdx: index('books_format_pk_idx').on(t.formatPk),
	}),
);

export const bookContributors = pgTable(
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
			foreignColumns: [contributors.pk],
		}).onDelete('cascade'),
		roleFk: foreignKey({
			columns: [t.rolePk],
			foreignColumns: [contributorRoles.pk],
		}).onDelete('cascade'),
	}),
);

export const bookGenres = pgTable(
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

export const genreChildren = pgTable(
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

export const bookIdentifiers = pgTable(
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
		resourceUnique: uniqueIndex('book_identifiers_resource_unique').on(t.resource),
	}),
);

export const contributorIdentifiers = pgTable(
	'contributor_identifiers',
	{
		contributorPk: text('contributor_pk').notNull(),
		resource: text('resource').notNull(),
		url: text('url').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.contributorPk, t.resource] }),
		contributorFk: foreignKey({
			columns: [t.contributorPk],
			foreignColumns: [contributors.pk],
		}).onDelete('cascade'),
		resourceUnique: uniqueIndex('contributor_identifiers_resource_unique').on(t.resource),
	}),
);

export const genreIdentifiers = pgTable(
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
		resourceUnique: uniqueIndex('genre_identifiers_resource_unique').on(t.resource),
	}),
);

// ─── Jetstream-indexed user content ──────────────────────────────────────────

/**
 * Generic index of user-owned biblio records (reviews, shelves, book
 * shelvings, actor profiles), ingested live from the Jetstream firehose.
 * One row per `(did, collection, rkey)` record; `record` holds the raw
 * lexicon-typed JSON value as written by the user's own PDS.
 */
export const userRecords = pgTable(
	'user_records',
	{
		did: text('did').notNull(),
		collection: text('collection').notNull(),
		rkey: text('rkey').notNull(),
		cid: text('cid').notNull(),
		record: jsonb('record').notNull(),
		indexedAt: integer('indexed_at').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.did, t.collection, t.rkey] }),
		collectionIdx: index('user_records_collection_idx').on(t.collection),
		didCollectionIdx: index('user_records_did_collection_idx').on(t.did, t.collection),
	}),
);

export type UserRecord = typeof userRecords.$inferSelect;
export type NewUserRecord = typeof userRecords.$inferInsert;

/** Single-row-per-consumer cursor checkpoint for resuming the Jetstream subscription. */
export const jetstreamCursor = pgTable('jetstream_cursor', {
	name: text('name').primaryKey(),
	cursor: bigint('cursor', { mode: 'number' }),
	updatedAt: integer('updated_at').notNull(),
});

export type JetstreamCursor = typeof jetstreamCursor.$inferSelect;

// ─── Google Books response cache ─────────────────────────────────────────────

/**
 * Postgres-backed HTTP response cache for Google Books queries. Keyed on a
 * hash of `(endpoint, canonical-json(params))`; an entry is valid until
 * `expires_at` is past. Pruned by the hourly `pnpm run gb:evict` script
 * declared as a worker in the Procfile and scheduled by dokku-cron.
 */
export const gbCache = pgTable(
	'gb_cache',
	{
		requestHash: text('request_hash').primaryKey(),
		endpoint: text('endpoint').notNull(),
		response: jsonb('response').notNull(),
		expiresAt: integer('expires_at').notNull(),
		createdAt: integer('created_at').notNull().default(sql`extract(epoch from now())::int`),
	},
	(t) => ({
		expiresAtIdx: index('gb_cache_expires_at_idx').on(t.expiresAt),
		endpointIdx: index('gb_cache_endpoint_idx').on(t.endpoint),
	}),
);

export type GbCache = typeof gbCache.$inferSelect;
export type NewGbCache = typeof gbCache.$inferInsert;
