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
    workFk: foreignKey({
      columns: [t.workUri],
      foreignColumns: [works.uri],
      name: 'editions_work_uri_fk',
    }),
    publisherFk: foreignKey({
      columns: [t.publisherUri],
      foreignColumns: [publishers.uri],
      name: 'editions_publisher_uri_fk',
    }),
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
    imprintOfFk: foreignKey({
      columns: [t.imprintOfUri],
      foreignColumns: [publishers.uri],
      name: 'publishers_imprint_of_uri_fk',
    }),
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
