import { pgTable, text, jsonb, timestamp, integer, boolean, bigserial, bigint, index, foreignKey, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const editions = pgTable(
  'editions',
  {
    uri: text('uri').primaryKey(),
    cid: text('cid').notNull(),
    did: text('did').notNull(),
    rkey: text('rkey').notNull(),
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
      .$type<Array<{ uri: string; resource: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    description: text('description'),
    coverImageUrl: text('cover_image_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    indexedAtIdx: index('editions_indexed_at_idx').on(t.indexedAt),
    didIdx: index('editions_did_idx').on(t.did),
    // editions.work_uri / editions.publisher_uri FKs are declared in the
    // initial migration (kept out of the schema to avoid the self-reference
    // cycle through publishers.imprint_of_uri).
  }),
);

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
      .$type<Array<{ uri: string; resource: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    didIdx: index('works_did_idx').on(t.did),
    indexedAtIdx: index('works_indexed_at_idx').on(t.indexedAt),
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
    bornYear: integer('born_year'),
    diedYear: integer('died_year'),
    identifiers: jsonb('identifiers')
      .$type<Array<{ uri: string; resource: string }>>()
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
      .$type<Array<{ uri: string; resource: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    didIdx: index('publishers_did_idx').on(t.did),
    indexedAtIdx: index('publishers_indexed_at_idx').on(t.indexedAt),
    nameIdx: index('publishers_name_idx').on(t.name),
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
  },
  (t) => ({
    collectionIdx: index('records_collection_idx').on(t.collection),
    indexedAtIdx: index('records_indexed_at_idx').on(t.indexedAt),
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
    editionIdx: index('edition_work_votes_edition_idx').on(t.editionUri),
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
    subjectIdx: index('labels_subject_idx').on(t.uri),
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
export const follows = pgTable('follows', {
  followerDid: text('follower_did').notNull(),
  followedDid: text('followed_did').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.followerDid, t.followedDid] }),
  followedIdx: index('follows_followed_did_idx').on(t.followedDid),
}));

export type FollowRow = typeof follows.$inferSelect;
export type LibrarianApplicationRow = typeof librarianApplications.$inferSelect;
