import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema.js';
import { generateRkey } from './rkey.js';

export const COLLECTIONS = {
  book: 'community.lexicon.book.book',
  claim: 'community.lexicon.book.claim',
  review: 'community.lexicon.book.review',
  status: 'community.lexicon.book.status',
  shelf: 'community.lexicon.book.shelf',
  shelfItem: 'community.lexicon.book.shelfItem',
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
}

export async function insertBook(
  db: BetterSQLite3Database<typeof schema>,
  input: BookInput,
  opts: { status?: string; rkey?: string; createdAt?: string } = {},
): Promise<{ uri: string; rkey: string }> {
  const rkey = opts.rkey ?? generateRkey();
  const now = opts.createdAt ?? new Date().toISOString();
  const uri = makeRecordUri(input.did, COLLECTIONS.book, rkey);

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
    status: opts.status ?? 'pending',
    createdAt: now,
    updatedAt: now,
  }).run();

  return { uri, rkey };
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
