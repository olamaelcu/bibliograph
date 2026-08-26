import { pgTable, text, jsonb, timestamp, integer, bigserial, bigint, index, foreignKey } from 'drizzle-orm/pg-core';
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    didIdx: index('contributors_did_idx').on(t.did),
    indexedAtIdx: index('contributors_indexed_at_idx').on(t.indexedAt),
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
