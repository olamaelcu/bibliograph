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
		releaseStatus: text('release_status').notNull().default('staged'),
		releasedAt: integer('released_at'),
	},
	(t) => ({
		titleIdx: index('works_title_idx').on(t.title),
		releaseStatusIdx: index('works_release_status_idx').on(t.releaseStatus),
		releaseStatusCheck: check(
			'works_release_status_check',
			sql`${t.releaseStatus} IN ('staged', 'released', 'rejected')`,
		),
	}),
);

export const contributors = sqliteTable(
	'contributors',
	{
		pk: text('pk').primaryKey(),
		name: text('name').notNull(),
		sortName: text('sort_name'),
		bio: text('bio'),
		imageUrl: text('image_url'),
		cid: text('cid').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at'),
		releaseStatus: text('release_status').notNull().default('staged'),
		releasedAt: integer('released_at'),
	},
	(t) => ({
		nameIdx: index('contributors_name_idx').on(t.name),
		releaseStatusIdx: index('contributors_release_status_idx').on(t.releaseStatus),
		releaseStatusCheck: check(
			'contributors_release_status_check',
			sql`${t.releaseStatus} IN ('staged', 'released', 'rejected')`,
		),
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
		releaseStatus: text('release_status').notNull().default('staged'),
		releasedAt: integer('released_at'),
	},
	(t) => ({
		parentFk: foreignKey({ columns: [t.parentPk], foreignColumns: [t.pk] }).onDelete('set null'),
		nameIdx: index('genres_name_idx').on(t.name),
		parentPkIdx: index('genres_parent_pk_idx').on(t.parentPk),
		releaseStatusIdx: index('genres_release_status_idx').on(t.releaseStatus),
		releaseStatusCheck: check(
			'genres_release_status_check',
			sql`${t.releaseStatus} IN ('staged', 'released', 'rejected')`,
		),
	}),
);

export const contributorRoles = sqliteTable(
	'contributor_roles',
	{
		pk: text('pk').primaryKey(),
		name: text('name').notNull(),
		description: text('description').notNull(),
		iconImageUrl: text('icon_image_url'),
		cid: text('cid').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		releaseStatus: text('release_status').notNull().default('staged'),
		releasedAt: integer('released_at'),
	},
	(t) => ({
		releaseStatusIdx: index('contributor_roles_release_status_idx').on(t.releaseStatus),
		releaseStatusCheck: check(
			'contributor_roles_release_status_check',
			sql`${t.releaseStatus} IN ('staged', 'released', 'rejected')`,
		),
	}),
);

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
		releaseStatus: text('release_status').notNull().default('staged'),
		releasedAt: integer('released_at'),
	},
	(t) => ({
		workPkIdx: index('books_work_pk_idx').on(t.workPk),
		formatPkIdx: index('books_format_pk_idx').on(t.formatPk),
		releaseStatusIdx: index('books_release_status_idx').on(t.releaseStatus),
		releaseStatusCheck: check(
			'books_release_status_check',
			sql`${t.releaseStatus} IN ('staged', 'released', 'rejected')`,
		),
	}),
);

export const bookContributorStaging = sqliteTable(
	'book_contributor_staging',
	{
		editionOlKey: text('edition_ol_key').notNull(),
		authorOlKey: text('author_ol_key').notNull(),
		rolePk: text('role_pk').notNull().default('author'),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.editionOlKey, t.authorOlKey, t.rolePk] }),
	}),
);

export type BookContributorStaging = typeof bookContributorStaging.$inferSelect;
export type NewBookContributorStaging = typeof bookContributorStaging.$inferInsert;

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
			foreignColumns: [contributors.pk],
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
		resourceUnique: uniqueIndex('book_identifiers_resource_unique').on(t.resource),
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
		resourceUnique: uniqueIndex('work_identifiers_resource_unique').on(t.resource),
	}),
);

export const contributorIdentifiers = sqliteTable(
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
		urlIdx: index('contributor_identifiers_url_idx').on(t.url),
		resourceUnique: uniqueIndex('contributor_identifiers_resource_unique').on(t.resource),
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
		resourceUnique: uniqueIndex('genre_identifiers_resource_unique').on(t.resource),
	}),
);

// ─── Staged-release lifecycle ────────────────────────────────────────────────

export const releaseStatuses = ['staged', 'released', 'rejected'] as const;
export type ReleaseStatus = (typeof releaseStatuses)[number];

export const importIssueEntityTypes = ['book', 'work', 'contributor', 'genre', 'contributorRole'] as const;
export type ImportIssueEntityType = (typeof importIssueEntityTypes)[number];

export const importIssueStatuses = ['open', 'resolved', 'dismissed'] as const;
export type ImportIssueStatus = (typeof importIssueStatuses)[number];

export const importIssues = sqliteTable(
	'import_issues',
	{
		pk: integer('pk').primaryKey({ autoIncrement: true }),
		entityType: text('entity_type').notNull(),
		entityPk: text('entity_pk').notNull(),
		field: text('field').notNull(),
		incomingValue: text('incoming_value'),
		storedValue: text('stored_value'),
		source: text('source').notNull(),
		status: text('status').notNull().default('open'),
		createdAt: integer('created_at').notNull(),
		resolvedAt: integer('resolved_at'),
	},
	(t) => ({
		entityIdx: index('import_issues_entity_idx').on(t.entityType, t.entityPk),
		statusIdx: index('import_issues_status_idx').on(t.status),
		entityTypeCheck: check(
			'import_issues_entity_type_check',
			sql`${t.entityType} IN ('book', 'work', 'contributor', 'genre', 'contributorRole')`,
		),
		statusCheck: check(
			'import_issues_status_check',
			sql`${t.status} IN ('open', 'resolved', 'dismissed')`,
		),
	}),
);

export type ImportIssue = typeof importIssues.$inferSelect;
export type NewImportIssue = typeof importIssues.$inferInsert;

	export const backfillState = sqliteTable('backfill_state', {
		name: text('name').primaryKey(),
		url: text('url'),
		filePath: text('file_path'),
		lastModified: text('last_modified'),
		fileSize: integer('file_size'),
		lastByteOffset: integer('last_byte_offset'),
		cursor: text('cursor'),
		totalProcessed: integer('total_processed'),
		totalRecords: integer('total_records'),
		complete: integer('complete').notNull().default(0),
		stopped: integer('stopped').notNull().default(0),
		updatedAt: integer('updated_at').notNull(),
	});

export type BackfillState = typeof backfillState.$inferSelect;

export const backfillReservation = sqliteTable('backfill_reservation', {
	stateName: text('state_name').primaryKey(),
	pid: integer('pid').notNull(),
	startedAt: integer('started_at').notNull(),
});

export type BackfillReservation = typeof backfillReservation.$inferSelect;

export const catalogBlobs = sqliteTable(
	'catalog_blobs',
	{
		pk: text('pk').primaryKey(),
		entityType: text('entity_type').notNull(),
		entityPk: text('entity_pk').notNull(),
		kind: text('kind').notNull(),
		cid: text('cid').notNull(),
		mimeType: text('mime_type'),
		size: integer('size'),
		objectKey: text('object_key').notNull(),
		source: text('source').notNull(),
		createdAt: integer('created_at').notNull(),
	},
	(t) => ({
		entityIdx: index('catalog_blobs_entity_idx').on(t.entityType, t.entityPk),
	}),
);

export type CatalogBlob = typeof catalogBlobs.$inferSelect;
export type NewCatalogBlob = typeof catalogBlobs.$inferInsert;

// ─── Jetstream-indexed user content ──────────────────────────────────────────

/**
 * Generic index of user-owned biblio records (reviews, shelves, book
 * shelvings, actor profiles), ingested live from the Jetstream firehose.
 * One row per `(did, collection, rkey)` record; `record` holds the raw
 * lexicon-typed JSON value as written by the user's own PDS.
 */
export const userRecords = sqliteTable(
	'user_records',
	{
		did: text('did').notNull(),
		collection: text('collection').notNull(),
		rkey: text('rkey').notNull(),
		cid: text('cid').notNull(),
		record: text('record', { mode: 'json' }).notNull(),
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
export const jetstreamCursor = sqliteTable('jetstream_cursor', {
	name: text('name').primaryKey(),
	cursor: integer('cursor'),
	updatedAt: integer('updated_at').notNull(),
});

export type JetstreamCursor = typeof jetstreamCursor.$inferSelect;
