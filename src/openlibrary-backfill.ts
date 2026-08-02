import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { generateRkey } from './rkey.js';
import { OpenLibraryProvider, type AuthorSearchResult } from './providers/openlibrary.js';
import type { BookData } from './providers/interface.js';
import { logger } from './logger.js';

const SERVICE_DID = process.env.ATP_SERVICE_DID || 'did:web:localhost';

export interface BackfillSummary {
  imported: number;
  skipped: number;
  notFound: number;
  failed: number;
}

type InsertOutcome = 'imported' | 'skipped' | 'failed';

async function importBookData(
  db: BetterSQLite3Database<typeof schema>,
  data: BookData,
  seen: Set<string>,
): Promise<InsertOutcome> {
  const canonical = data.isbn13 || data.isbn10;
  const workKey = data.identifiers['openlibrary'];
  const dedupKey = workKey || canonical;
  if (dedupKey) {
    if (seen.has(dedupKey)) return 'skipped';
    seen.add(dedupKey);
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
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run();
    return 'imported';
  } catch (err) {
    logger.error({ err, uri }, 'openlibrary: import failed');
    return 'failed';
  }
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

    const outcome = await importBookData(db, data, seen);
    if (outcome === 'imported') {
      summary.imported += 1;
      logger.info({ isbn }, 'openlibrary: imported');
    } else if (outcome === 'skipped') {
      summary.skipped += 1;
      logger.info({ isbn }, 'openlibrary: already present, skipping');
    } else {
      summary.failed += 1;
    }
  }

  logger.info({ ...summary }, 'openlibrary backfill complete');
  return summary;
}

export async function backfillOpenLibraryAuthor(
  db: BetterSQLite3Database<typeof schema>,
  authorKey: string,
  opts: { limit?: number } = {},
): Promise<BackfillSummary> {
  if (!/^OL\d+[A-Z]$/.test(authorKey)) {
    throw new Error(`invalid OpenLibrary author key: ${authorKey}`);
  }

  const provider = new OpenLibraryProvider();
  const summary: BackfillSummary = { imported: 0, skipped: 0, notFound: 0, failed: 0 };
  const seen = new Set<string>();
  const limit = opts.limit ?? 100;
  let page = 1;
  let total = Infinity;

  while ((page - 1) * limit < total) {
    let result: AuthorSearchResult | null;
    try {
      result = await provider.searchByAuthorKey(authorKey, page, limit);
    } catch (err) {
      logger.error({ err, authorKey }, 'openlibrary: author search failed');
      result = null;
    }
    if (!result || result.docs.length === 0) {
      if (page === 1) summary.notFound = 1;
      break;
    }
    total = result.total;

    for (const doc of result.docs) {
      const outcome = await importBookData(db, doc, seen);
      if (outcome === 'imported') {
        summary.imported += 1;
        logger.info({ authorKey, title: doc.title }, 'openlibrary: author book imported');
      } else if (outcome === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
      }
    }
    page += 1;
  }

  logger.info({ authorKey, ...summary }, 'openlibrary author backfill complete');
  return summary;
}
