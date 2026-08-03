import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { computeDeduplicationHash } from './dedup.js';
import { logger } from './logger.js';

export interface DuplicateGroup {
  hash: string;
  title: string;
  author: string;
  books: Array<{
    uri: string;
    did: string;
    title: string;
    author: string;
    isbn: string | null;
    publishedDate: string | null;
    identifiers: Array<{ type: string; value: string }>;
    createdAt: string;
    updatedAt: string;
    pageCount: number | null;
    description: string | null;
    coverUrl: string | null;
    status: string;
  }>;
}

export interface DuplicateAnalysis {
  totalBooks: number;
  uniqueHashes: number;
  duplicateGroups: number;
  totalDuplicateRecords: number;
  groups: DuplicateGroup[];
}

function hashBook(book: { title: string; author: string; publishedDate: string | null }): string {
  return computeDeduplicationHash(book.title, book.author, book.publishedDate ?? undefined);
}

export async function analyzeDuplicates(
  db: BetterSQLite3Database<typeof schema>,
  limit: number = 50,
): Promise<DuplicateAnalysis> {
  const books = await db.select({
    uri: schema.books.uri,
    did: schema.books.did,
    title: schema.books.title,
    author: schema.books.author,
    isbn: schema.books.isbn,
    publishedDate: schema.books.publishedDate,
    identifiers: schema.books.identifiers,
    createdAt: schema.books.createdAt,
    updatedAt: schema.books.updatedAt,
    pageCount: schema.books.pageCount,
    description: schema.books.description,
    coverUrl: schema.books.coverUrl,
    status: schema.books.status,
  }).from(schema.books).all();

  const hashGroups = new Map<string, typeof books>();

  for (const book of books) {
    const hash = hashBook(book);
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash)!.push(book);
  }

  const duplicateGroups: DuplicateGroup[] = [];

  for (const [hash, groupBooks] of hashGroups) {
    if (groupBooks.length < 2) continue;
    const first = groupBooks[0];
    duplicateGroups.push({
      hash,
      title: first.title,
      author: first.author,
      books: groupBooks.map((b) => ({
        uri: b.uri,
        did: b.did,
        title: b.title,
        author: b.author,
        isbn: b.isbn,
        publishedDate: b.publishedDate,
        identifiers: b.identifiers as Array<{ type: string; value: string }>,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        pageCount: b.pageCount,
        description: b.description,
        coverUrl: b.coverUrl,
        status: b.status,
      })),
    });
  }

  duplicateGroups.sort((a, b) => {
    if (b.books.length !== a.books.length) return b.books.length - a.books.length;
    return a.title.localeCompare(b.title);
  });

  const totalDuplicateRecords = duplicateGroups.reduce((sum, g) => sum + g.books.length, 0);

  return {
    totalBooks: books.length,
    uniqueHashes: hashGroups.size,
    duplicateGroups: duplicateGroups.length,
    totalDuplicateRecords,
    groups: duplicateGroups.slice(0, limit),
  };
}

export async function updateBookHash(
  db: BetterSQLite3Database<typeof schema>,
  bookUri: string,
): Promise<string | null> {
  const book = await db.query.books.findFirst({
    where: eq(schema.books.uri, bookUri),
    columns: { uri: true, title: true, author: true, publishedDate: true },
  });

  if (!book) return null;

  const hash = hashBook(book);

  await db
    .update(schema.books)
    .set({ deduplicationHash: hash })
    .where(eq(schema.books.uri, bookUri))
    .run();

  return hash;
}

export async function populateAllHashes(
  db: BetterSQLite3Database<typeof schema>,
  batchSize: number = 100,
): Promise<{ updated: number }> {
  const rows = await db
    .select({ uri: schema.books.uri, title: schema.books.title, author: schema.books.author, publishedDate: schema.books.publishedDate, deduplicationHash: schema.books.deduplicationHash })
    .from(schema.books)
    .all();

  let updated = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const row of batch) {
      const hash = hashBook(row);
      if (row.deduplicationHash === hash) continue;
      await db
        .update(schema.books)
        .set({ deduplicationHash: hash })
        .where(eq(schema.books.uri, row.uri))
        .run();
      updated++;
    }
    if (updated % 1000 === 0) {
      logger.info({ updated, total: rows.length }, 'hash population progress');
    }
  }

  logger.info({ updated }, 'deduplication hash population complete');
  return { updated };
}

export async function getStats(
  db: BetterSQLite3Database<typeof schema>,
): Promise<{
  totalBooks: number;
  hashPopulated: number;
  duplicateGroups: number;
  totalDuplicates: number;
}> {
  const analysis = await analyzeDuplicates(db, 1000);
  const [{ cnt: total }] = db
    .select({ cnt: sql<number>`count(*)` })
    .from(schema.books)
    .all();
  const [{ cnt: populated }] = db
    .select({ cnt: sql<number>`count(*)` })
    .from(schema.books)
    .where(sql`deduplication_hash IS NOT NULL`)
    .all();

  return {
    totalBooks: total,
    hashPopulated: populated,
    duplicateGroups: analysis.duplicateGroups,
    totalDuplicates: analysis.totalDuplicateRecords,
  };
}
