import { pgTable, text, jsonb, timestamp, integer, index, foreignKey } from 'drizzle-orm/pg-core';
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
export type PublisherRow = typeof publishers.$inferSelect;
export type RecordRow = typeof records.$inferSelect;
