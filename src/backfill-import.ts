import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { generateRkey } from './rkey.js';
import { computeDeduplicationHash } from './dedup.js';
import type { BookData } from './providers/interface.js';
import { logger } from './logger.js';

export const SERVICE_DID = process.env.ATP_SERVICE_DID || 'did:web:localhost';

export interface BackfillSummary {
  imported: number;
  skipped: number;
  notFound: number;
  failed: number;
}

export type InsertOutcome = 'imported' | 'skipped' | 'failed';

export async function importBookData(
  db: BetterSQLite3Database<typeof schema>,
  data: BookData,
  seen: Set<string>,
  dedupIdentifierType: string,
): Promise<InsertOutcome> {
  const canonical = data.isbn13 || data.isbn10;
  const idKey = data.identifiers[dedupIdentifierType];
  const dedupKey = idKey || canonical;
  if (dedupKey) {
    if (seen.has(dedupKey)) return 'skipped';
    seen.add(dedupKey);
  }

  const dhash = computeDeduplicationHash(data.title, data.author, data.publishedDate);

  if (dhash) {
    const hashMatch = await db.query.books.findFirst({
      where: eq(schema.books.deduplicationHash, dhash),
    });
    if (hashMatch) return 'skipped';
  }

  if (canonical) {
    const existing = await db.query.books.findFirst({ where: eq(schema.books.isbn, canonical) });
    if (existing) return 'skipped';
  }

  const now = new Date().toISOString();
  const uri = `at://${SERVICE_DID}/community.lexicon.book.book/${generateRkey()}`;
  try {
    await db.insert(schema.books).values({
      uri,
      did: SERVICE_DID,
      title: data.title,
      author: data.author,
      isbn: canonical,
      publishedDate: data.publishedDate,
      description: data.description,
      pageCount: data.pageCount,
      language: data.language,
      categories: data.categories || [],
      identifiers: Object.entries(data.identifiers).map(([type, value]) => ({ type, value })),
      coverUrl: data.coverUrl,
      deduplicationHash: dhash,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run();
    return 'imported';
  } catch (err) {
    logger.error({ err, uri }, 'backfill: import failed');
    return 'failed';
  }
}
