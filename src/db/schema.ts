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
 * Catalog records (editions, contributors) back the PDS at
 * `community.lexicon.book.*`. User-owned records (shelves, book shelvings,
 * actor profiles) are Jetstream-indexed via the `user_records` table and
 * served under `net.olamaelcu.livtet.biblio.*` as app-private extensions.
 *
 * Every primary key is a `text` value: ATProto record keys (TIDs) or
 * grandfathered slugs (in transition). Timestamps are unix seconds
 * (`integer`). Many-to-many relationships are inlined as JSON (e.g.
 * `editions.contributors`).
 */

export const contributors = pgTable(
	'contributors',
	{
		pk: text('pk').primaryKey(),
		name: text('name').notNull(),
		nameLower: text('name_lower'),
		sortName: text('sort_name'),
		bio: text('bio'),
		cid: text('cid').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at'),
	},
	(t) => ({
		nameLowerIdx: index('contributors_name_lower_idx').on(t.nameLower),
	}),
);

export const editions = pgTable(
	'editions',
	{
		pk: text('pk').primaryKey(),
		title: text('title').notNull(),
		subtitle: text('subtitle'),
		language: text('language'),
		place: text('place'),
		workUri: text('work_uri'),
		publisherUri: text('publisher_uri'),
		publishedYear: integer('published_year'),
		description: text('description'),
		contributors: jsonb('contributors').notNull().default(sql`'[]'::jsonb`),
		cid: text('cid').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at'),
	},
	(t) => ({
		titleIdx: index('editions_title_idx').on(t.title),
		createdAtIdx: index('editions_created_at_idx').on(t.createdAt),
	}),
);

export const bookIdentifiers = pgTable(
	'book_identifiers',
	{
		bookPk: text('book_pk').notNull(),
		valueScheme: text('value_scheme').notNull(),
		value: text('value').notNull(),
		uri: text('uri').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.bookPk, t.valueScheme, t.value] }),
		bookFk: foreignKey({ columns: [t.bookPk], foreignColumns: [editions.pk] }).onDelete('cascade'),
		uriIdx: index('book_identifiers_uri_idx').on(t.uri),
		valueUnique: uniqueIndex('book_identifiers_value_unique').on(t.valueScheme, t.value),
	}),
);

export const contributorIdentifiers = pgTable(
	'contributor_identifiers',
	{
		contributorPk: text('contributor_pk').notNull(),
		valueScheme: text('value_scheme').notNull(),
		value: text('value').notNull(),
		uri: text('uri').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.contributorPk, t.valueScheme, t.value] }),
		contributorFk: foreignKey({
			columns: [t.contributorPk],
			foreignColumns: [contributors.pk],
		}).onDelete('cascade'),
		valueUnique: uniqueIndex('contributor_identifiers_value_unique').on(t.valueScheme, t.value),
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