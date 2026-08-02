import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { GoogleBooksProvider } from './providers/googlebooks.js';
import { importBookData, type BackfillSummary } from './backfill-import.js';
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
): Promise<BackfillSummary> {
  const provider = new GoogleBooksProvider(requireKey());
  const summary: BackfillSummary = { imported: 0, skipped: 0, notFound: 0, failed: 0 };
  const seen = new Set<string>();

  for (const raw of isbns) {
    const isbn = raw.trim();
    if (!isbn) continue;

    const data = await provider.searchByIsbn(isbn);
    if (!data) {
      summary.notFound += 1;
      logger.info({ isbn }, 'googlebooks: not found');
      continue;
    }

    const outcome = await importBookData(db, data, seen, 'googleBooks');
    if (outcome === 'imported') {
      summary.imported += 1;
      logger.info({ isbn }, 'googlebooks: imported');
    } else if (outcome === 'skipped') {
      summary.skipped += 1;
      logger.info({ isbn }, 'googlebooks: already present, skipping');
    } else {
      summary.failed += 1;
    }
  }

  logger.info({ ...summary }, 'googlebooks backfill complete');
  return summary;
}

export async function backfillGoogleBooksAuthor(
  db: BetterSQLite3Database<typeof schema>,
  authorName: string,
  opts: { maxResults?: number } = {},
): Promise<BackfillSummary> {
  if (!authorName.trim()) {
    throw new Error('author name is required');
  }

  const provider = new GoogleBooksProvider(requireKey());
  const summary: BackfillSummary = { imported: 0, skipped: 0, notFound: 0, failed: 0 };
  const seen = new Set<string>();
  const seenTitles = new Set<string>();
  const maxResults = opts.maxResults ?? 40;
  let startIndex = 0;
  let totalItems = Infinity;

  while (startIndex < totalItems) {
    let result;
    try {
      result = await provider.searchByAuthorName(authorName, startIndex, maxResults);
    } catch (err) {
      logger.error({ err, authorName }, 'googlebooks: author search failed');
      result = null;
    }
    if (!result || result.items.length === 0) {
      if (startIndex === 0) summary.notFound = 1;
      break;
    }
    totalItems = result.totalItems;

    for (const item of result.items) {
      const titleKey = `${item.title}|${item.author}`.toLowerCase();
      if (seenTitles.has(titleKey)) {
        summary.skipped += 1;
        continue;
      }
      seenTitles.add(titleKey);

      const outcome = await importBookData(db, item, seen, 'googleBooks');
      if (outcome === 'imported') {
        summary.imported += 1;
        logger.info({ authorName, title: item.title }, 'googlebooks: author book imported');
      } else if (outcome === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
      }
    }
    startIndex += result.items.length;
  }

  logger.info({ authorName, ...summary }, 'googlebooks author backfill complete');
  return summary;
}
