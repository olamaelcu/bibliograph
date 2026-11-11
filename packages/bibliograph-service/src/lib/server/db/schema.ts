import { pgTable, text, jsonb, timestamp, integer, bigserial, bigint, boolean, index, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Identifier } from '../identifiers';
import type { SeriesValue } from '../catalog/types';

// ─── Catalog ────────────────────────────────────────────────────────────────
// Editions are the mutable source of truth. Contributors and publishers are
// entities linked through join tables so a rename or merge updates one row
// instead of every edition that credits it. The inline arrays/objects the
// books-wg record carries are materialized only by `appview_book` (the read
// model) and `editionRecordValue` (publication).

export const editions = pgTable(
  'editions',
  {
    uri: text('uri').primaryKey(),
    rkey: text('rkey').notNull().unique().default(sql`editions_next_tid()`),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    language: text('language'),
    publishedDate: text('published_date'),
    format: text('format'),
    pages: integer('pages'),
    durationSeconds: integer('duration_seconds'),
    chapters: integer('chapters'),
    series: jsonb('series').$type<SeriesValue>(),
    bookEdition: text('book_edition'),
    description: text('description'),
    coverUrl: text('cover_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    descriptionCheckedAt: timestamp('description_checked_at', { withTimezone: true }),
    coverCheckedAt: timestamp('cover_checked_at', { withTimezone: true }),
  },
  (t) => ({
    createdAtIdx: index('editions_created_at_idx').on(t.createdAt.desc(), t.uri),
  }),
);

export type EditionRow = typeof editions.$inferSelect;

export const editionIdentifiers = pgTable(
  'edition_identifiers',
  {
    editionUri: text('edition_uri')
      .notNull()
      .references(() => editions.uri, { onDelete: 'cascade' }),
    issuer: text('issuer').notNull(),
    value: text('value').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.editionUri, t.issuer, t.value] }),
    lookupIdx: index('edition_identifiers_lookup_idx').on(t.issuer, t.value),
  }),
);

export const contributors = pgTable(
  'contributors',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    identifiers: jsonb('identifiers')
      .$type<Identifier[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identityIdx: uniqueIndex('contributors_identity_idx').on(sql`lower(${t.name})`, t.identifiers),
  }),
);

export type ContributorRow = typeof contributors.$inferSelect;

export const publishers = pgTable(
  'publishers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    identifiers: jsonb('identifiers')
      .$type<Identifier[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identityIdx: uniqueIndex('publishers_identity_idx').on(sql`lower(${t.name})`, t.identifiers),
  }),
);

export type PublisherRow = typeof publishers.$inferSelect;

export const editionContributors = pgTable(
  'edition_contributors',
  {
    editionUri: text('edition_uri')
      .notNull()
      .references(() => editions.uri, { onDelete: 'cascade' }),
    contributorId: bigint('contributor_id', { mode: 'number' })
      .notNull()
      .references(() => contributors.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    role: text('role').notNull().default('author'),
    ref: text('ref'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.editionUri, t.position] }),
    contributorIdx: index('edition_contributors_contributor_idx').on(t.contributorId),
  }),
);

export const editionPublishers = pgTable(
  'edition_publishers',
  {
    editionUri: text('edition_uri')
      .notNull()
      .references(() => editions.uri, { onDelete: 'cascade' }),
    publisherId: bigint('publisher_id', { mode: 'number' })
      .notNull()
      .references(() => publishers.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.editionUri, t.position] }),
    publisherIdx: index('edition_publishers_publisher_idx').on(t.publisherId),
  }),
);

// ─── Publication outbox ─────────────────────────────────────────────────────
// Triggers on the catalog tables enqueue rows here; the graphile publisher
// drains them into the PDS repo. `pds_cids` remembers the last published CID so
// the worker chooses create/update without a read.

export const pdsOutbox = pgTable(
  'pds_outbox',
  {
    uri: text('uri').primaryKey(),
    collection: text('collection').notNull(),
    rkey: text('rkey').notNull(),
    op: text('op').$type<'create' | 'update' | 'delete'>().notNull(),
    value: jsonb('value'),
    attempts: integer('attempts').notNull().default(0),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    nextAt: timestamp('next_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    readyIdx: index('pds_outbox_ready_idx').on(t.nextAt).where(sql`attempts < 10`),
  }),
);

export type PdsOutboxRow = typeof pdsOutbox.$inferSelect;

export const pdsCids = pgTable('pds_cids', {
  uri: text('uri').primaryKey(),
  cid: text('cid').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Catalog backfill bookkeeping ───────────────────────────────────────────
// A row records a terminal verdict so a scheduled scan does not re-ask upstream
// about the same edition forever.

export const editionGoodreadsBackfill = pgTable('edition_goodreads_backfill', {
  uri: text('uri')
    .primaryKey()
    .references(() => editions.uri, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  reason: text('reason'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});

export const editionIsbnEnrichment = pgTable('edition_isbn_enrichment', {
  uri: text('uri').primaryKey(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  result: text('result').notNull(),
  candidates: jsonb('candidates').$type<
    Array<{
      source: string;
      isbn: string;
      title?: string;
      score: number;
      accepted: boolean;
      reject?: string;
    }>
  >(),
});

export const backfillEvents = pgTable(
  'backfill_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    job: text('job').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceUri: text('resource_uri').notNull(),
    resourceRkey: text('resource_rkey').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    origin: text('origin'),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    durationMs: integer('duration_ms'),
    jobId: bigint('job_id', { mode: 'number' }),
    jobKey: text('job_key'),
    error: text('error'),
    detail: jsonb('detail'),
  },
  (t) => ({
    occurredIdx: index('backfill_events_occurred_idx').on(t.occurredAt),
    jobOccurredIdx: index('backfill_events_job_occurred_idx').on(t.job, t.occurredAt),
    typeOccurredIdx: index('backfill_events_type_occurred_idx').on(t.resourceType, t.occurredAt),
    outcomeOccurredIdx: index('backfill_events_outcome_occurred_idx').on(t.outcome, t.occurredAt),
    uriOccurredIdx: index('backfill_events_uri_occurred_idx').on(t.resourceUri, t.occurredAt),
  }),
);

export type BackfillEventRow = typeof backfillEvents.$inferSelect;

// ─── Labeler ────────────────────────────────────────────────────────────────
// Issued labels are persisted with their signature: the DID document's
// #atproto_label key can rotate, and only stored signatures let old labels be
// re-served (or re-signed) consistently.

export const labels = pgTable(
  'labels',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    src: text('src').notNull(),
    uri: text('uri').notNull(),
    val: text('val').notNull(),
    cid: text('cid'),
    neg: boolean('neg').notNull().default(false),
    cts: timestamp('cts', { withTimezone: true }).notNull(),
    exp: timestamp('exp', { withTimezone: true }),
    /** Signature over the dag-cbor encoding of the label, base64 (the `$bytes` form). */
    sig: text('sig').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subjectValIdx: index('labels_subject_val_idx').on(t.uri, t.val),
  }),
);

export const librarianApplications = pgTable(
  'librarian_applications',
  {
    did: text('did').primaryKey(),
    handle: text('handle'),
    note: text('note'),
    status: text('status').$type<'pending' | 'approved' | 'rejected' | 'revoked'>().notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
  },
  (t) => ({
    statusIdx: index('librarian_applications_status_idx').on(t.status, t.requestedAt),
  }),
);

export type LabelRow = typeof labels.$inferSelect;
export type LibrarianApplicationRow = typeof librarianApplications.$inferSelect;

// ─── Provider caches ────────────────────────────────────────────────────────
// Shared between processes so one API key's quota is not burned twice on the
// same query. A NULL `body` is a negative entry.

export const googleBooksCache = pgTable(
  'google_books_cache',
  {
    key: text('key').primaryKey(),
    url: text('url').notNull(),
    body: jsonb('body'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresAtIdx: index('google_books_cache_expires_at_idx').on(t.expiresAt),
  }),
);

export type GoogleBooksCacheRow = typeof googleBooksCache.$inferSelect;

export const isbndbCache = pgTable(
  'isbndb_cache',
  {
    key: text('key').primaryKey(),
    request: text('request').notNull(),
    body: jsonb('body'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresAtIdx: index('isbndb_cache_expires_at_idx').on(t.expiresAt),
  }),
);

export type IsbndbCacheRow = typeof isbndbCache.$inferSelect;
