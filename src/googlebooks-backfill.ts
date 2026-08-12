import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { GoogleBooksProvider } from './providers/googlebooks.js';
import { backfillFromIsbns, createSummary, recordImportOutcome } from './backfill-utils.js';
import { importBookData } from './backfill-import.js';
import { logger } from './logger.js';

function requireKey(): string {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) {
    throw new Error('GOOGLE_BOOKS_API_KEY is not set; googlebooks backfill requires an API key');
  }
  return key;
}

export async function backfillGoogleBooksFromIsbns(
  db: BetterSQLite3Database<typeof schema>,
  isbns: string[],
): Promise<import('./backfill-import.js').BackfillSummary> {
  return backfillFromIsbns(db, new GoogleBooksProvider(requireKey()), 'googlebooks', 'googleBooks', isbns);
}

export async function backfillGoogleBooksAuthor(
  db: BetterSQLite3Database<typeof schema>,
  authorName: string,
  opts: { maxResults?: number; maxPages?: number } = {},
): Promise<import('./backfill-import.js').BackfillSummary> {
  if (!authorName.trim()) {
    throw new Error('author name is required');
  }

  const provider = new GoogleBooksProvider(requireKey());
  const summary = createSummary();
  const seen = new Set<string>();
  const seenTitles = new Set<string>();
  const maxResults = opts.maxResults ?? 40;
  const maxPages = opts.maxPages ?? 200;
  let startIndex = 0;
  let pageSize = maxResults;
  let pages = 0;

  while (pages < maxPages) {
    pages += 1;
    let result;
    try {
      result = await provider.searchByAuthorName(authorName, startIndex, maxResults);
    } catch (err) {
      logger.error({ err, authorName }, 'googlebooks: author search failed');
      break;
    }
    if (!result || result.items.length === 0) {
      if (startIndex === 0) summary.notFound = 1;
      break;
    }

    for (const item of result.items) {
      const titleKey = `${item.title}|${item.contributors[0]?.name ?? ''}`.toLowerCase();
      if (seenTitles.has(titleKey)) {
        summary.skipped += 1;
        continue;
      }
      seenTitles.add(titleKey);

      const outcome = await importBookData(db, item, seen, 'googleBooks');
      recordImportOutcome(
        summary,
        outcome,
        { authorName, title: item.title },
        { imported: 'googlebooks: author book imported' },
      );
    }

    startIndex += result.items.length;
    // Google's reported total can be capped/inaccurate, so keep paging until
    // the server returns a page smaller than the last full page (or empty).
    if (pages > 1 && result.items.length < pageSize) break;
    pageSize = result.items.length;
  }

  if (pages >= maxPages) {
    logger.warn({ authorName, maxPages }, 'googlebooks: author pagination hit page cap');
  }

  logger.info({ authorName, ...summary }, 'googlebooks author backfill complete');
  return summary;
}
