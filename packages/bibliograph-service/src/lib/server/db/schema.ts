import { pgTable, text, jsonb, timestamp, integer, boolean, bigserial, bigint, index, foreignKey, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Identifier } from '../identifiers';

export const editions = pgTable(
  'editions',
  {
    uri: text('uri').primaryKey(),
    cid: text('cid').notNull(),
    did: text('did').notNull(),
    rkey: text('rkey').notNull(),
    // Canonical book identity. rkeys are provider namespaces (`ol.*`, `gb.*`,
    // `bh.*`, `isbndb.*`), so one book can arrive under several uris and a
    // librarian merge can retire the losers; `tid` is the platform-wide key
    // saying "these uris describe one book". ATProto TID format (13-char
    // lowercase base32, top bit clear) because that is the identifier shape the
    // protocol already defines for records — minted by `editions_next_tid()`
    // (migration 0020) so every insert path, scripts included, gets one.
    tid: text('tid').notNull().unique().default(sql`editions_next_tid()`),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    workUri: text('work_uri'),
    workCid: text('work_cid'),
    // Who last decided `work_uri`: null/'auto' = the backfill-works reconciler,
    // 'consensus' = applied from editionWorkLink votes. The reconciler leaves
    // 'consensus' rows alone so a user-driven unlink is not silently undone.
    workLinkSource: text('work_link_source'),
    publisherUri: text('publisher_uri'),
    publisherCid: text('publisher_cid'),
    place: text('place'),
    publishedYear: integer('published_year'),
    language: text('language'),
    contributors: jsonb('contributors')
      .$type<Array<{ subject: { uri: string; cid: string }; role: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    identifiers: jsonb('identifiers')
      .$type<Identifier[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    description: text('description'),
    coverImageUrl: text('cover_image_url'),
    // Normalized display metadata: `hardcover` | `paperback` | `ebook` |
    // `audiobook`, and the provider's page count. Both feed the AppView's
    // `bookView`; `pages` is also part of the edition record lexicon.
    format: text('format'),
    pages: integer('pages'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    descriptionCheckedAt: timestamp('description_checked_at', { withTimezone: true }),
    // Set by the cover backfill when a lookup concluded (found or not), so the
    // scheduled scan does not re-ask providers about the same cover forever.
    coverCheckedAt: timestamp('cover_checked_at', { withTimezone: true }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    indexedAtIdx: index('editions_indexed_at_idx').on(t.indexedAt),
    // `getEditionsByContributor` orders by the record's own stamp. Without this
    // index its contributor filter (an `EXISTS` over the contributors jsonb,
    // which no index can serve) would scan and sort every match instead of
    // stopping once `limit` rows have been handed out.
    createdAtIdx: index('editions_created_at_idx').on(t.createdAt.desc(), t.uri),
    didIdx: index('editions_did_idx').on(t.did),
    // Catalog lookups reach rows by `rkey` — the Bookhive mirror audit's
    // `EXISTS`, and `edition-work-actions` resolving an edition — which without
    // this index is a sequential scan of the whole catalog per lookup.
    rkeyIdx: index('editions_rkey_idx').on(t.rkey),
    // The recommendation feed joins subject-sharing works back to their
    // editions; without this, every "For You" read scanned the catalog.
    workUriIdx: index('editions_work_uri_idx')
      .on(t.workUri)
      .where(sql`${t.workUri} IS NOT NULL`),
    // editions.work_uri / editions.publisher_uri FKs are declared in the
    // initial migration (kept out of the schema to avoid the self-reference
    // cycle through publishers.imprint_of_uri).
  }),
);

/**
 * Retired catalog uris → the book they meant (migration 0020).
 *
 * A librarian merge deletes the losing rows, but shelving rows, reviews and
 * clients keep pointing at those uris, and a re-ingest would otherwise recreate
 * the duplicate under a fresh `tid`. Every reader handed an edition uri resolves
 * it through here (`edition-lookup.ts`), so all of a book's uris answer with the
 * one surviving record. `ON DELETE CASCADE` keeps the table honest when the
 * canonical row is deleted (catalog takedown).
 */
export const editionAliases = pgTable(
  'edition_aliases',
  {
    uri: text('uri').primaryKey(),
    tid: text('tid')
      .notNull()
      .references(() => editions.tid, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Reverse lookup ("which uris did this book absorb") and the cascade delete.
    tidIdx: index('edition_aliases_tid_idx').on(t.tid),
  }),
);

/**
 * Goodreads backfill bookkeeping.
 *
 * A book that Goodreads does not have must not be re-fetched on every run: it
 * would trip the failure-rate guard forever and never let the scan advance.
 * `not_found` is a terminal state here until an operator deletes the row.
 */
export const editionGoodreadsBackfill = pgTable('edition_goodreads_backfill', {
  uri: text('uri')
    .primaryKey()
    .references(() => editions.uri, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  reason: text('reason'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});


/**
 * Works backfill bookkeeping.
 *
 * One row records the reconciler's verdict about one edition, which is what
 * keeps the scan finite: `unmatched` rows were written while a work provider
 * still answered, and a run skips them until an operator deletes the row (or
 * runs the backfill with `--retry-unmatched`).
 *
 * Phase 1 now defers rather than answers: with no work provider left to ask, an
 * orphan keeps `work_uri` NULL and only increments the run's `deferred` count,
 * writing no row at all. Nothing therefore claims the catalog was consulted,
 * and every orphan stays eligible if a work source appears again.
 */
export const editionWorkBackfill = pgTable('edition_work_backfill', {
  uri: text('uri')
    .primaryKey()
    .references(() => editions.uri, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  reason: text('reason'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ISBN enrichment bookkeeping (migration 0012).
 *
 * Kept out of `editions` on purpose: it is backfill state, not part of the
 * served record, and a row here is what makes the scan finite — without it
 * every run re-asks upstream about the same ISBN-less book.
 */
export const editionIsbnEnrichment = pgTable('edition_isbn_enrichment', {
  uri: text('uri')
    .primaryKey()
    .references(() => editions.uri, { onDelete: 'cascade' }),
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

export const works = pgTable(
  'works',
  {
    uri: text('uri').primaryKey(),
    cid: text('cid').notNull(),
    did: text('did').notNull(),
    rkey: text('rkey').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    originalLanguage: text('original_language'),
    firstPublishedYear: integer('first_published_year'),
    subjects: jsonb('subjects').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    contributors: jsonb('contributors')
      .$type<Array<{ subject: { uri: string; cid: string }; role: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    identifiers: jsonb('identifiers')
      .$type<Identifier[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    descriptionCheckedAt: timestamp('description_checked_at', { withTimezone: true }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    didIdx: index('works_did_idx').on(t.did),
    indexedAtIdx: index('works_indexed_at_idx').on(t.indexedAt),
    // The "For You" feed joins works by shared subjects. Default `jsonb_ops`
    // (not `jsonb_path_ops`) because the feed pre-filters with `subjects ?|`,
    // which only the default operator class can answer.
    subjectsIdx: index('works_subjects_gin').using('gin', t.subjects),
  }),
);

export const contributors = pgTable(
  'contributors',
  {
    uri: text('uri').primaryKey(),
    cid: text('cid').notNull(),
    did: text('did').notNull(),
    rkey: text('rkey').notNull(),
    name: text('name').notNull(),
    aliases: jsonb('aliases').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    linkedDid: text('linked_did'),
    bio: text('bio'),
    bioCheckedAt: timestamp('bio_checked_at', { withTimezone: true }),
    bornYear: integer('born_year'),
    diedYear: integer('died_year'),
    identifiers: jsonb('identifiers')
      .$type<Identifier[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    imageUrl: text('image_url'),
    imageSource: text('image_source'),
    imageArtist: text('image_artist'),
    imageLicense: text('image_license'),
    imageLicenseUrl: text('image_license_url'),
    imageAttributionRequired: boolean('image_attribution_required').notNull().default(false),
    imageCheckedAt: timestamp('image_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    didIdx: index('contributors_did_idx').on(t.did),
    indexedAtIdx: index('contributors_indexed_at_idx').on(t.indexedAt),
    imageCheckedAtIdx: index('contributors_image_checked_at_idx').on(t.imageCheckedAt),
    // `NOT NULL` alone still admits '' / whitespace, which violates the
    // lexicon's `minLength: 1`. Enforce the real invariant in the database.
    nameNonEmpty: check('contributors_name_non_empty', sql`btrim(${t.name}) <> ''`),
  }),
);

export const publishers = pgTable(
  'publishers',
  {
    uri: text('uri').primaryKey(),
    cid: text('cid').notNull(),
    did: text('did').notNull(),
    rkey: text('rkey').notNull(),
    name: text('name').notNull(),
    imprintOfUri: text('imprint_of_uri'),
    imprintOfCid: text('imprint_of_cid'),
    foundingDate: integer('founding_date'),
    closingDate: integer('closing_date'),
    identifiers: jsonb('identifiers')
      .$type<Identifier[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    indexedAtIdx: index('publishers_indexed_at_idx').on(t.indexedAt),
    // `searchPublishers` filters `name ILIKE '%q%'`; 0005 created the trigram
    // indexes for editions/works/contributors only.
    nameTrgmIdx: index('publishers_name_trgm').using('gin', sql`name gin_trgm_ops`),
    // Note: self-FK on imprintOfUri is declared in the migration (drizzle-kit
    // can't infer types for self-referencing tables).
  }),
);

export const records = pgTable(
  'records',
  {
    uri: text('uri').primaryKey(),
    cid: text('cid').notNull(),
    did: text('did').notNull(),
    rkey: text('rkey').notNull(),
    collection: text('collection').notNull(),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    // The record's own `createdAt`, which is what the feed and listing reads sort
    // by (`db/record-recency`). Generated so the sort is indexable: Postgres only
    // accepts IMMUTABLE generation expressions, and text→timestamptz is merely
    // STABLE (it reads the session timezone), so what is stored is the ISO string
    // itself. Blank when the record carries none — under `desc` a blank sorts
    // last, which keeps the key total and the keyset cursor free of NULLs.
    recordCreatedAt: text('record_created_at')
      .notNull()
      .generatedAlwaysAs(sql`coalesce(value->>'createdAt', '')`),
  },
  (t) => ({
    collectionIdx: index('records_collection_idx').on(t.collection),
    didCollectionIdx: index('records_did_collection_idx').on(t.did, t.collection),
    recordCreatedAtIdx: index('records_record_created_at_idx').on(t.recordCreatedAt.desc(), t.uri.desc()),
    // The shelving and review reads filter on jsonb paths, not columns:
    // `listBooksOnShelf`/`listShelvesWithBooks` match `value->>'shelf'`,
    // `getShelvingOfBook`/`getShelversOfBook` match `value->'book'->>'uri'`, and
    // the Bookhive join matches `value->>'hiveBookUri'`. Without these every one
    // of them was a sequential scan: `listShelvesWithBooks` measured 90-108 s on
    // production, and 10 s after the indexes were added.
    shelfUriIdx: index('records_shelf_uri_idx').on(sql`(value->>'shelf')`),
    bookUriIdx: index('records_book_uri_idx').on(sql`(value->'book'->>'uri')`),
    hiveBookUriIdx: index('records_hivebook_idx').on(sql`(value->>'hiveBookUri')`),
    // The Bookhive reads fold the legacy `hiveId` shape through a coalesce (see
    // `shelving/shelf-rows.ts` bookhiveSubjectSql), which the bare expression
    // index above cannot serve: that predicate scanned all of `records`.
    hiveBookSubjectIdx: index('records_hivebook_subject_idx')
      .on(sql`(coalesce(value->>'hiveBookUri', 'at://did:plc:enu2j5xjlqsjaylv3du4myh4/buzz.bookhive.catalogBook/' || (value->>'hiveId')))`)
      .where(sql`${t.collection} = 'buzz.bookhive.book'`),
    // `listShelvesWithBooks` previews one Bookhive shelf at a time by status.
    bookhiveStatusIdx: index('records_bookhive_status_idx')
      .on(t.did, sql`(value->>'status')`)
      .where(sql`${t.collection} = 'buzz.bookhive.book' AND (value->>'status') IS NOT NULL`),
    // `getReviewsByBook` ORs three shapes for the review's book; only the
    // `value->'book'->>'uri'` form above is indexed today.
    reviewBookLegacyIdx: index('records_review_book_legacy_idx')
      .on(sql`(value->>'book')`)
      .where(sql`${t.collection} = 'net.olamaelcu.livtet.biblio.bookReview'`),
    reviewBookRefIdx: index('records_review_book_ref_idx')
      .on(sql`(value->'book'->>'ref')`)
      .where(sql`${t.collection} = 'net.olamaelcu.livtet.biblio.bookReview'`),
  }),
);

export type EditionRow = typeof editions.$inferSelect;
export type WorkRow = typeof works.$inferSelect;
export type ContributorRow = typeof contributors.$inferSelect;
export type PublisherRow = typeof publishers.$inferSelect;
export type RecordRow = typeof records.$inferSelect;

export const ingestDeadLetter = pgTable(
  'ingest_dead_letter',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uri: text('uri').notNull().unique(),
    payload: jsonb('payload').notNull(),
    errorMessage: text('error_message').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdAtIdx: index('ingest_dead_letter_created_at_idx').on(t.createdAt),
  }),
);

export const tapDeadLetter = pgTable(
  'tap_dead_letter',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventSeq: bigint('event_seq', { mode: 'number' }),
    repoDid: text('repo_did').notNull(),
    collection: text('collection').notNull(),
    rkey: text('rkey').notNull(),
    payload: jsonb('payload').notNull(),
    errorMessage: text('error_message').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdAtIdx: index('tap_dead_letter_created_at_idx').on(t.createdAt),
    didIdx: index('tap_dead_letter_did_idx').on(t.repoDid),
  }),
);

export type IngestDeadLetterRow = typeof ingestDeadLetter.$inferSelect;
export type TapDeadLetterRow = typeof tapDeadLetter.$inferSelect;

// ─── Edition→work link votes ────────────────────────────────────────────────
// Materialized from `net.olamaelcu.livtet.biblio.editionWorkLink` records in
// users' own repos. One row per (edition, voter): a user changing their mind
// updates their existing vote rather than stacking a second one. Consensus over
// these rows is applied to `editions.work_uri` by edition-work-votes.ts.

export const editionWorkVotes = pgTable(
  'edition_work_votes',
  {
    editionUri: text('edition_uri').notNull(),
    voterDid: text('voter_did').notNull(),
    action: text('action').$type<'link' | 'unlink'>().notNull(),
    workUri: text('work_uri'),
    workCid: text('work_cid'),
    recordUri: text('record_uri').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.editionUri, t.voterDid] }),
    // `forgetVoteByRecordUri` deletes by `record_uri`; the composite primary
    // key already covers `edition_uri` lookups.
    recordUriIdx: index('edition_work_votes_record_uri_idx').on(t.recordUri),
  }),
);

// ─── Follow graph ───────────────────────────────────────────────────────────
// Materialized from `net.olamaelcu.livtet.biblio.follow` records in the
// follower's own repo (`subject` = the followed actor's at-uri). The repo stays
// authoritative; this table is a derived read index that answers "who follows
// me" (leading `followed_did` index) and "who do I follow" (the primary key's
// leading `follower_did`). `tapRecordUpsertTask` and `tapRecordDeleteTask` keep
// it in step, and `drizzle/0028_follows_restore.sql` seeds it from `records`.

export const follows = pgTable(
  'follows',
  {
    followerDid: text('follower_did').notNull(),
    followedDid: text('followed_did').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.followerDid, t.followedDid] }),
    followedIdx: index('follows_followed_did_idx').on(t.followedDid),
  }),
);

// ─── OAuth client persistence ───────────────────────────────────────────────
// Backing stores for @atproto/oauth-client-node. `value` holds the serialized
// session/state, including DPoP key material, so it must never be exposed.

export const oauthSessions = pgTable('oauth_sessions', {
  did: text('did').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauthStates = pgTable('oauth_states', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// ─── Browser sessions ───────────────────────────────────────────────────────
// The cookie carries only an opaque random id; the DID lives here, so a forged
// cookie cannot claim someone else's OAuth session.

export const webSessions = pgTable(
  'web_sessions',
  {
    id: text('id').primaryKey(),
    did: text('did').notNull(),
    handle: text('handle'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresAtIdx: index('web_sessions_expires_at_idx').on(t.expiresAt),
  }),
);

export type EditionWorkVoteRow = typeof editionWorkVotes.$inferSelect;
export type FollowRow = typeof follows.$inferSelect;
export type WebSessionRow = typeof webSessions.$inferSelect;

// ─── Labeler ────────────────────────────────────────────────────────────────
// Issued labels are persisted with their signature: the DID document's
// #atproto_label key can rotate, and only stored signatures let old labels be
// re-served (or re-signed) consistently. `seq` is the public stream order used by
// com.atproto.label.subscribeLabels, so it must be monotonic and gap-free enough
// for cursor backfill — a bigserial is the simplest guarantee.

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
    // The (uri, val) composite serves every `uri`-only lookup as a prefix.
    subjectValIdx: index('labels_subject_val_idx').on(t.uri, t.val),
  }),
);

// Applications for the `librarian` label, reviewed by an admin.

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

// ─── Google Books response cache ─────────────────────────────────────────────
// The GB quota is charged per request against one API key, and both the web and
// the worker processes share that key, so the cache has to be shared too — a
// process-local Map would let each process burn its own quota on the same query.
//
// `body` is the verbatim upstream JSON, replayed through the same mappers as a
// fresh response, so a cache hit cannot produce a different edition shape than a
// live call. A NULL body is a negative entry: upstream answered "no such volume",
// which is worth remembering for the same TTL because a delisted volume would
// otherwise be re-queried on every hydration and every backfill run.

export const googleBooksCache = pgTable(
  'google_books_cache',
  {
    /** sha256 of the cache-normalized request URL (see gbCacheEntry). */
    key: text('key').primaryKey(),
    /** The normalized URL, for audit. Never carries the API key. */
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

// ISBNdb responses, cached exactly like Google Books above and for the same
// reasons. `key` is over method + normalized request + body, so the bulk
// `POST /books` question and a single `GET /book/{isbn}` never collide. A NULL
// body is a negative entry (upstream has no such ISBN).
export const isbndbCache = pgTable(
  'isbndb_cache',
  {
    /** sha256 over method + cache-normalized request + body (see isbndbCacheEntry). */
    key: text('key').primaryKey(),
    /** What was asked, for audit. Never carries the API key (it is a header). */
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
