import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import * as schema from './db/schema.js';
import { generateRkey } from './rkey.js';
import { computeDeduplicationHash } from './dedup.js';
import type { Cover } from './cover-types.js';
import { cidForRecord } from './pds/cid.js';
import {
  serializeBook,
  serializeContributor,
  serializeContributorType,
} from './pds/records.js';

export const COLLECTIONS = {
  book: 'community.lexicon.book.book',
  claim: 'community.lexicon.book.claim',
  review: 'community.lexicon.book.review',
  status: 'community.lexicon.book.status',
  shelf: 'community.lexicon.book.shelf',
  shelfItem: 'community.lexicon.book.shelfItem',
  contributor: 'community.lexicon.book.contributor',
  contributorType: 'community.lexicon.book.contributor.type',
  contributorClaim: 'community.lexicon.book.contributor.claim',
} as const;

export function makeRecordUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`;
}

export function makeId(): { rkey: string; now: string } {
  return { rkey: generateRkey(), now: new Date().toISOString() };
}

export interface BookInput {
  did: string;
  title: string;
  author: string;
  isbn?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  language?: string;
  categories?: string[];
  identifiers: Array<{ type: string; value: string }>;
  coverUrl?: string;
  cover?: Cover;
}

export async function insertBook(
  db: BetterSQLite3Database<typeof schema>,
  input: BookInput,
  opts: { status?: string; rkey?: string; createdAt?: string } = {},
): Promise<{ uri: string; rkey: string; cid: string }> {
  const rkey = opts.rkey ?? generateRkey();
  const now = opts.createdAt ?? new Date().toISOString();
  const uri = makeRecordUri(input.did, COLLECTIONS.book, rkey);

  const dedupHash = computeDeduplicationHash(input.title, input.author, input.publishedDate);

  const value = serializeBook({
    uri,
    did: input.did,
    title: input.title,
    author: input.author,
    isbn: input.isbn ?? null,
    publishedDate: input.publishedDate ?? null,
    description: input.description ?? null,
    pageCount: input.pageCount ?? null,
    language: input.language ?? 'en',
    categories: input.categories ?? [],
    identifiers: input.identifiers,
    contributors: [],
    coverUrl: input.coverUrl ?? null,
    cover: input.cover ?? null,
    deduplicationHash: dedupHash,
    status: opts.status ?? 'pending',
    cid: null,
    createdAt: now,
    updatedAt: now,
  });
  const cid = await cidForRecord(value);

  await db.insert(schema.books).values({
    uri,
    did: input.did,
    title: input.title,
    author: input.author,
    isbn: input.isbn,
    publishedDate: input.publishedDate,
    description: input.description,
    pageCount: input.pageCount,
    language: input.language,
    categories: input.categories ?? [],
    identifiers: input.identifiers,
    coverUrl: input.coverUrl,
    cover: input.cover,
    deduplicationHash: dedupHash,
    status: opts.status ?? 'pending',
    cid,
    createdAt: now,
    updatedAt: now,
  }).run();

  return { uri, rkey, cid };
}

export interface ClaimInput {
  did: string;
  bookUri: string;
  identifier: string;
  identifierType: string;
  claimedBy?: string;
}

export async function insertClaim(
  db: BetterSQLite3Database<typeof schema>,
  input: ClaimInput,
  opts: { status?: string; rkey?: string; createdAt?: string } = {},
): Promise<{ uri: string; rkey: string }> {
  const rkey = opts.rkey ?? generateRkey();
  const now = opts.createdAt ?? new Date().toISOString();
  const uri = makeRecordUri(input.did, COLLECTIONS.claim, rkey);

  await db.insert(schema.claims).values({
    uri,
    did: input.did,
    bookUri: input.bookUri,
    identifier: input.identifier,
    identifierType: input.identifierType,
    claimedBy: input.claimedBy ?? input.did,
    status: opts.status ?? 'pending',
    createdAt: now,
  }).run();

  return { uri, rkey };
}

export function findBookByIsbn(
  db: BetterSQLite3Database<typeof schema>,
  isbn: string,
): Promise<typeof schema.books.$inferSelect | undefined> {
  return db.query.books.findFirst({ where: eq(schema.books.isbn, isbn) });
}

// ─── Contributors ───────────────────────────────────────────────────────────

export interface ContributorImage {
  url: string;
  alt?: string;
}

export interface ContributorInput {
  did: string;
  name: string;
  altNames?: string[];
  images?: ContributorImage[];
  identifiers: Array<{ type: string; value: string }>;
  bio?: string;
}

export async function insertContributor(
  db: BetterSQLite3Database<typeof schema>,
  input: ContributorInput,
  opts: { rkey?: string; createdAt?: string } = {},
): Promise<{ uri: string; rkey: string; cid: string }> {
  const rkey = opts.rkey ?? generateRkey();
  const now = opts.createdAt ?? new Date().toISOString();
  const uri = makeRecordUri(input.did, COLLECTIONS.contributor, rkey);

  const cid = await cidForRecord(
    serializeContributor({
      uri,
      did: input.did,
      name: input.name,
      altNames: input.altNames ?? [],
      images: input.images ?? [],
      identifiers: input.identifiers,
      bio: input.bio ?? null,
      cid: null,
      createdAt: now,
    }),
  );

  await db
    .insert(schema.contributors)
    .values({
      uri,
      did: input.did,
      name: input.name,
      altNames: input.altNames ?? [],
      images: input.images ?? [],
      identifiers: input.identifiers,
      bio: input.bio,
      cid,
      createdAt: now,
    })
    .run();

  return { uri, rkey, cid };
}

export async function findContributorByIdentifier(
  db: BetterSQLite3Database<typeof schema>,
  type: string,
  value: string,
): Promise<typeof schema.contributors.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(schema.contributors)
    .where(
      sql`EXISTS (SELECT 1 FROM json_each(${schema.contributors.identifiers}) je WHERE json_extract(je.value, '$.type') = ${type} AND json_extract(je.value, '$.value') = ${value})`,
    )
    .limit(1);
  return rows[0];
}

export function findContributorByUri(
  db: BetterSQLite3Database<typeof schema>,
  uri: string,
): Promise<typeof schema.contributors.$inferSelect | undefined> {
  return db.query.contributors.findFirst({ where: eq(schema.contributors.uri, uri) });
}

// ─── Contributor Types ──────────────────────────────────────────────────────

export interface ContributorTypeInput {
  did: string;
  name: string;
  description?: string;
}

export async function insertContributorType(
  db: BetterSQLite3Database<typeof schema>,
  input: ContributorTypeInput,
  opts: { rkey?: string; createdAt?: string } = {},
): Promise<{ uri: string; rkey: string; cid: string }> {
  const rkey = opts.rkey ?? generateRkey();
  const now = opts.createdAt ?? new Date().toISOString();
  const uri = makeRecordUri(input.did, COLLECTIONS.contributorType, rkey);

  const cid = await cidForRecord(
    serializeContributorType({
      uri,
      did: input.did,
      name: input.name,
      description: input.description ?? null,
      cid: null,
      createdAt: now,
    }),
  );

  await db
    .insert(schema.contributorTypes)
    .values({
      uri,
      did: input.did,
      name: input.name,
      description: input.description,
      cid,
      createdAt: now,
    })
    .run();

  return { uri, rkey, cid };
}

export function findContributorTypeByName(
  db: BetterSQLite3Database<typeof schema>,
  name: string,
): Promise<typeof schema.contributorTypes.$inferSelect | undefined> {
  return db.query.contributorTypes.findFirst({
    where: eq(schema.contributorTypes.name, name),
  });
}
