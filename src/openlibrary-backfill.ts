import { eq, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { generateRkey } from './rkey.js';
import { OpenLibraryProvider } from './providers/openlibrary.js';
import { logger } from './logger.js';

const SERVICE_DID = process.env.ATP_SERVICE_DID || 'did:web:localhost';

export interface BackfillSummary {
  imported: number;
  skipped: number;
  notFound: number;
  failed: number;
}

export async function backfillOpenLibraryFromIsbns(
  db: BetterSQLite3Database<typeof schema>,
  isbns: string[],
): Promise<BackfillSummary> {
  const provider = new OpenLibraryProvider();
  const summary: BackfillSummary = { imported: 0, skipped: 0, notFound: 0, failed: 0 };
  const seen = new Set<string>();

  for (const raw of isbns) {
    const isbn = raw.trim();
    if (!isbn) continue;

    const data = await provider.searchByIsbn(isbn);
    if (!data) {
      summary.notFound += 1;
      logger.info({ isbn }, 'openlibrary: not found');
      continue;
    }

    const canonical = data.isbn13 || data.isbn10 || isbn;
    if (seen.has(canonical)) { summary.skipped += 1; continue; }
    seen.add(canonical);

    const existing = await db.query.books.findFirst({
      where: or(eq(schema.books.isbn, canonical), eq(schema.books.isbn, isbn)),
    });
    if (existing) {
      summary.skipped += 1;
      logger.info({ isbn, uri: existing.uri }, 'openlibrary: already present, skipping');
      continue;
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
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }).run();
      summary.imported += 1;
      logger.info({ isbn, uri }, 'openlibrary: imported');
    } catch (err) {
      summary.failed += 1;
      logger.error({ err, isbn }, 'openlibrary: import failed');
    }
  }

  logger.info({ ...summary }, 'openlibrary backfill complete');
  return summary;
}
