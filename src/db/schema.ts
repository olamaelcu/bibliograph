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

// ─── Type aliases for JSON columns ───────────────────────────────────────────

type Identifier = { type: string; value: string };

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
    coverUrl: text(),
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
    bookTitle: text('book_title').notNull(),
    bookAuthor: text('book_author').notNull(),
    createdAt: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    bookUriIdx: index('reviews_book_uri_idx').on(table.bookUri),
    didIdx: index('reviews_did_idx').on(table.did),
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
