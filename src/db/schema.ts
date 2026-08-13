import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  check,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import type { Cover } from '../cover-types.js';

// ─── Type aliases for JSON columns ───────────────────────────────────────────

type Identifier = { type: string; value: string };

type BookProgress = {
  percent?: number;
  currentPage?: number;
  totalPages?: number;
  currentChapter?: number;
  totalChapters?: number;
  updatedAt?: string;
};

// ─── Books ───────────────────────────────────────────────────────────────────

export const books = sqliteTable(
  'books',
  {
    uri: text().primaryKey(),
    did: text().notNull(),
    title: text().notNull(),
    author: text().notNull(),
    isbn: text().unique(),
    publishedDate: text(),
    description: text(),
    pageCount: integer(),
    language: text().default('en'),
    categories: text({ mode: 'json' }).$type<string[]>().default(sql`'[]'`),
    identifiers: text({ mode: 'json' }).$type<Identifier[]>().default(sql`'[]'`),
    contributors: text({ mode: 'json' })
      .$type<Array<{ contributor?: { uri?: string; cid?: string }; role?: { uri?: string; cid?: string }; order?: number }>>()
      .default(sql`'[]'`),
    coverUrl: text(),
    cover: text({ mode: 'json' }).$type<Cover>(),
    deduplicationHash: text('deduplication_hash'),
    status: text().notNull().default('pending'),
    createdAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString())
      .$onUpdateFn(() => new Date().toISOString()),
  },
  (table) => ({
    titleIdx: index('books_title_idx').on(table.title),
    authorIdx: index('books_author_idx').on(table.author),
    statusIdx: index('books_status_idx').on(table.status),
    deduplicationHashIdx: index('books_deduplication_hash_idx').on(table.deduplicationHash),
    createdAtIdx: index('books_created_at_idx').on(table.createdAt),
    statusCreatedUriIdx: index('books_status_created_uri_idx').on(
      table.status,
      table.createdAt,
      table.uri,
    ),
    didIdx: index('books_did_idx').on(table.did),
    statusCheck: check('books_status_check', sql`${table.status} IN ('pending', 'active', 'rejected')`),
  }),
);

export type Book = typeof books.$inferSelect;
export type NewBook = typeof books.$inferInsert;

// ─── Claims ──────────────────────────────────────────────────────────────────

export const claims = sqliteTable(
  'claims',
  {
    uri: text().primaryKey(),
    did: text().notNull(),
    bookUri: text()
      .notNull()
      .references(() => books.uri, { onDelete: 'cascade' }),
    identifier: text().notNull(),
    identifierType: text().notNull(),
    claimedBy: text().notNull(),
    status: text().notNull().default('pending'),
    verifiedBy: text(),
    verifiedAt: text(),
    createdAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    bookUriIdx: index('claims_book_uri_idx').on(table.bookUri),
    statusIdx: index('claims_status_idx').on(table.status),
    claimedByIdx: index('claims_claimed_by_idx').on(table.claimedBy),
    identifierIdx: index('claims_identifier_idx').on(table.identifier),
    bookClaimedByUnique: uniqueIndex('claims_book_claimed_by_unique').on(
      table.bookUri,
      table.claimedBy,
    ),
    statusCheck: check(
      'claims_status_check',
      sql`${table.status} IN ('pending', 'verified', 'rejected')`,
    ),
    identifierTypeCheck: check(
      'claims_identifier_type_check',
      sql`${table.identifierType} IN ('isbn', 'ean', 'issn', 'asin', 'oclc')`,
    ),
  }),
);

export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;

// ─── Reviews ─────────────────────────────────────────────────────────────────

export const reviews = sqliteTable(
  'reviews',
  {
    uri: text().primaryKey(),
    did: text().notNull(),
    bookUri: text()
      .notNull()
      .references(() => books.uri, { onDelete: 'cascade' }),
    text: text().notNull(),
    rating: real(),
    cid: text(),
    bookTitle: text('book_title').notNull(),
    bookAuthor: text('book_author').notNull(),
    createdAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    bookUriIdx: index('reviews_book_uri_idx').on(table.bookUri),
    didIdx: index('reviews_did_idx').on(table.did),
    createdAtIdx: index('reviews_created_at_idx').on(table.createdAt),
    didCreatedAtIdx: index('reviews_did_created_at_idx').on(table.did, table.createdAt),
    bookUriCreatedAtIdx: index('reviews_book_uri_created_at_idx').on(table.bookUri, table.createdAt),
    ratingCheck: check(
      'reviews_rating_check',
      sql`${table.rating} IS NULL OR (${table.rating} >= 1 AND ${table.rating} <= 5)`,
    ),
  }),
);

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;

// ─── Reading Statuses ────────────────────────────────────────────────────────

export const readingStatuses = sqliteTable(
  'reading_statuses',
  {
    uri: text().primaryKey(),
    did: text().notNull(),
    bookUri: text()
      .notNull()
      .references(() => books.uri, { onDelete: 'cascade' }),
    status: text().notNull().default('to-read'),
    progress: real(),
    rating: real(),
    bookTitle: text('book_title').notNull(),
    bookAuthor: text('book_author').notNull(),
    identifiers: text({ mode: 'json' }).$type<Identifier[]>().default(sql`'[]'`),
    bookProgress: text({ mode: 'json' }).$type<BookProgress>(),
    startedAt: text(),
    finishedAt: text(),
    createdAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    bookUriIdx: index('reading_statuses_book_uri_idx').on(table.bookUri),
    didIdx: index('reading_statuses_did_idx').on(table.did),
    statusIdx: index('reading_statuses_status_idx').on(table.status),
    createdAtIdx: index('reading_statuses_created_at_idx').on(table.createdAt),
    didCreatedAtIdx: index('reading_statuses_did_created_at_idx').on(table.did, table.createdAt),
    bookUriCreatedAtIdx: index('reading_statuses_book_uri_created_at_idx').on(table.bookUri, table.createdAt),
    didBookUriUnique: uniqueIndex('reading_statuses_did_book_uri_unique').on(
      table.did,
      table.bookUri,
    ),
    statusCheck: check(
      'reading_statuses_status_check',
      sql`${table.status} IN ('reading', 'read', 'to-read', 'abandoned', 'wishlist')`,
    ),
    progressCheck: check(
      'reading_statuses_progress_check',
      sql`${table.progress} IS NULL OR (${table.progress} >= 0 AND ${table.progress} <= 100)`,
    ),
    ratingCheck: check(
      'reading_statuses_rating_check',
      sql`${table.rating} IS NULL OR (${table.rating} >= 1 AND ${table.rating} <= 5)`,
    ),
  }),
);

export type ReadingStatus = typeof readingStatuses.$inferSelect;
export type NewReadingStatus = typeof readingStatuses.$inferInsert;

// ─── Shelves ────────────────────────────────────────────────────────────────

export const shelves = sqliteTable(
  'shelves',
  {
    uri: text().primaryKey(),
    did: text().notNull(),
    name: text().notNull(),
    description: text(),
    metadata: text({ mode: 'json' }).$type<Record<string, unknown>>().default(sql`'{}'`),
    coverUrl: text(),
    cover: text({ mode: 'json' }).$type<Cover>(),
    createdAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString())
      .$onUpdateFn(() => new Date().toISOString()),
  },
  (table) => ({
    didIdx: index('shelves_did_idx').on(table.did),
    nameIdx: index('shelves_name_idx').on(table.name),
  }),
);

export type Shelf = typeof shelves.$inferSelect;
export type NewShelf = typeof shelves.$inferInsert;

// ─── Shelf Items ────────────────────────────────────────────────────────────

export const shelfItems = sqliteTable(
  'shelf_items',
  {
    uri: text().primaryKey(),
    did: text().notNull(),
    shelfUri: text()
      .notNull()
      .references(() => shelves.uri, { onDelete: 'cascade' }),
    bookUri: text()
      .notNull()
      .references(() => books.uri, { onDelete: 'cascade' }),
    bookTitle: text('book_title').notNull(),
    bookAuthor: text('book_author').notNull(),
    note: text(),
    createdAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    shelfUriIdx: index('shelf_items_shelf_uri_idx').on(table.shelfUri),
    bookUriIdx: index('shelf_items_book_uri_idx').on(table.bookUri),
    didIdx: index('shelf_items_did_idx').on(table.did),
    shelfBookUnique: uniqueIndex('shelf_items_shelf_book_unique').on(
      table.shelfUri,
      table.bookUri,
    ),
  }),
);

export type ShelfItem = typeof shelfItems.$inferSelect;
export type NewShelfItem = typeof shelfItems.$inferInsert;

// ─── Labels ─────────────────────────────────────────────────────────────────

export const bookLabels = sqliteTable(
  'book_labels',
  {
    src: text().notNull(),
    uri: text().notNull(),
    val: text().notNull(),
    cts: text().notNull(),
    neg: integer().notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.src, table.uri, table.val] }),
    uriIdx: index('book_labels_uri_idx').on(table.uri),
    valIdx: index('book_labels_val_idx').on(table.val),
  }),
);

export type BookLabel = typeof bookLabels.$inferSelect;
export type NewBookLabel = typeof bookLabels.$inferInsert;

// Append-only event log for label changes. `id` doubles as the atproto
// subscription `seq`. Published when a label is created or negated.
export const labelEvents = sqliteTable(
  'label_events',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    src: text().notNull(),
    uri: text().notNull(),
    val: text().notNull(),
    neg: integer().notNull().default(0),
    cts: text().notNull(),
  },
  (table) => ({
    uriIdx: index('label_events_uri_idx').on(table.uri),
  }),
);

export type LabelEvent = typeof labelEvents.$inferSelect;
export type NewLabelEvent = typeof labelEvents.$inferInsert;

// ─── Features (feature flags) ───────────────────────────────────────────────

export const features = sqliteTable('features', {
  name: text().primaryKey(),
  enabled: integer().notNull().default(0),
});

export type Feature = typeof features.$inferSelect;
export type NewFeature = typeof features.$inferInsert;

// ─── Backfill state (importer checkpoints) ─────────────────────────────────

export const backfillState = sqliteTable('backfill_state', {
  name: text().primaryKey(),
  url: text().notNull(),
  filePath: text('file_path').notNull(),
  lastModified: text('last_modified'),
  fileSize: integer('file_size'),
  lastByteOffset: integer('last_byte_offset').notNull().default(0),
  lastKeyCursor: text('last_key_cursor'),
  lastNumericCursor: integer('last_numeric_cursor'),
  totalProcessed: integer('total_processed').notNull().default(0),
  complete: integer({ mode: 'boolean' }).notNull().default(false),
  startedAt: text('started_at'),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdateFn(() => new Date().toISOString()),
});

export type BackfillState = typeof backfillState.$inferSelect;
export type NewBackfillState = typeof backfillState.$inferInsert;

// ─── Backfill reservation (coordination between importer and live writes) ──────

export const backfillReservation = sqliteTable('backfill_reservation', {
  stateName: text('state_name').primaryKey(),
  ownerPid: integer('owner_pid').notNull(),
  acquiredAt: integer('acquired_at').notNull(),
  heartbeatAt: integer('heartbeat_at').notNull(),
  batchSize: integer('batch_size').notNull(),
  status: text('status', { enum: ['active', 'closing'] }).notNull().default('active'),
});

export type BackfillReservation = typeof backfillReservation.$inferSelect;
export type NewBackfillReservation = typeof backfillReservation.$inferInsert;

// ─── Contributors ───────────────────────────────────────────────────────────

export const contributors = sqliteTable(
  'contributors',
  {
    uri: text().primaryKey(),
    did: text().notNull(),
    name: text().notNull(),
    altNames: text({ mode: 'json' }).$type<string[]>().default(sql`'[]'`),
    images: text({ mode: 'json' })
      .$type<Array<{ url: string; alt?: string }>>()
      .default(sql`'[]'`),
    identifiers: text({ mode: 'json' }).$type<Identifier[]>().default(sql`'[]'`),
    bio: text(),
    createdAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    nameIdx: index('contributors_name_idx').on(table.name),
    didIdx: index('contributors_did_idx').on(table.did),
    createdAtIdx: index('contributors_created_at_idx').on(table.createdAt),
  }),
);

export type Contributor = typeof contributors.$inferSelect;
export type NewContributor = typeof contributors.$inferInsert;

// ─── Contributor Types ──────────────────────────────────────────────────────

export const contributorTypes = sqliteTable(
  'contributor_types',
  {
    uri: text().primaryKey(),
    did: text().notNull(),
    name: text().notNull().unique(),
    description: text(),
    createdAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    didIdx: index('contributor_types_did_idx').on(table.did),
    nameIdx: index('contributor_types_name_idx').on(table.name),
  }),
);

export type ContributorType = typeof contributorTypes.$inferSelect;
export type NewContributorType = typeof contributorTypes.$inferInsert;

// ─── Book Contributors (join table for fast lookup) ────────────────────────

export const bookContributors = sqliteTable(
  'book_contributors',
  {
    bookUri: text()
      .notNull()
      .references(() => books.uri, { onDelete: 'cascade' }),
    contributorUri: text().notNull(),
    contributorCid: text().notNull(),
    roleUri: text().notNull(),
    roleCid: text().notNull(),
    ordering: integer().default(0),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.bookUri, table.contributorUri, table.roleUri],
    }),
    bookIdx: index('book_contributors_book_idx').on(table.bookUri),
    contributorIdx: index('book_contributors_contributor_idx').on(
      table.contributorUri,
    ),
    roleIdx: index('book_contributors_role_idx').on(table.roleUri),
  }),
);

export type BookContributor = typeof bookContributors.$inferSelect;
export type NewBookContributor = typeof bookContributors.$inferInsert;

// ─── Bookhive user discovery ────────────────────────────────────────────────

/**
 * Users discovered from @bookhive.buzz's `buzz.bookhive.activity` feed.
 * Each row is a user whose reading statuses we intend to backfill.
 */
export const bookhiveUserDiscovery = sqliteTable('bookhive_user_discovery', {
  did: text().primaryKey(),
  handle: text(),
  firstSeenActivityAt: text('first_seen_activity_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  bookCountDiscovered: integer('book_count_discovered').notNull().default(0),
  lastError: text('last_error'),
});

export type BookhiveUserDiscovery = typeof bookhiveUserDiscovery.$inferSelect;
export type NewBookhiveUserDiscovery = typeof bookhiveUserDiscovery.$inferInsert;
