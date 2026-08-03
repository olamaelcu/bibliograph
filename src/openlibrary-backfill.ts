import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { OpenLibraryProvider, type AuthorSearchResult } from './providers/openlibrary.js';
import { backfillFromIsbns, createSummary, importItems } from './backfill-utils.js';
import { logger } from './logger.js';

export type { BackfillSummary } from './backfill-import.js';

export async function backfillOpenLibraryFromIsbns(
  db: BetterSQLite3Database<typeof schema>,
  isbns: string[],
): Promise<import('./backfill-import.js').BackfillSummary> {
  return backfillFromIsbns(db, new OpenLibraryProvider(), 'openlibrary', 'openlibrary', isbns);
}

export async function backfillOpenLibraryAuthor(
  db: BetterSQLite3Database<typeof schema>,
  authorKey: string,
  opts: { limit?: number } = {},
): Promise<import('./backfill-import.js').BackfillSummary> {
  if (!/^OL\d+[A-Z]$/.test(authorKey)) {
    throw new Error(`invalid OpenLibrary author key: ${authorKey}`);
  }

  const provider = new OpenLibraryProvider();
  const summary = createSummary();
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

    await importItems(
      db,
      result.docs,
      seen,
      'openlibrary',
      summary,
      (doc) => ({ authorKey, title: doc.title }),
      'openlibrary: author book imported',
    );
    page += 1;
  }

  logger.info({ authorKey, ...summary }, 'openlibrary author backfill complete');
  return summary;
}
