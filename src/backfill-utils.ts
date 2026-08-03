import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { importBookData, type BackfillSummary, type InsertOutcome } from './backfill-import.js';
import type { BookData } from './providers/interface.js';
import { logger } from './logger.js';

export function createSummary(): BackfillSummary {
  return { imported: 0, skipped: 0, notFound: 0, failed: 0 };
}

export function recordImportOutcome(
  summary: BackfillSummary,
  outcome: InsertOutcome,
  context: Record<string, unknown>,
  messages: { imported?: string; skipped?: string } = {},
): void {
  switch (outcome) {
    case 'imported':
      summary.imported += 1;
      if (messages.imported) logger.info(context, messages.imported);
      break;
    case 'skipped':
      summary.skipped += 1;
      if (messages.skipped) logger.info(context, messages.skipped);
      break;
    default:
      summary.failed += 1;
  }
}

interface IsbnSearchable {
  searchByIsbn(isbn: string): Promise<BookData | null>;
}

export async function backfillFromIsbns(
  db: BetterSQLite3Database<typeof schema>,
  provider: IsbnSearchable,
  name: string,
  dedupType: string,
  isbns: string[],
): Promise<BackfillSummary> {
  const summary = createSummary();
  const seen = new Set<string>();

  for (const raw of isbns) {
    const isbn = raw.trim();
    if (!isbn) continue;

    const data = await provider.searchByIsbn(isbn);
    if (!data) {
      summary.notFound += 1;
      logger.info({ isbn }, `${name}: not found`);
      continue;
    }

    recordImportOutcome(
      summary,
      await importBookData(db, data, seen, dedupType),
      { isbn },
      { imported: `${name}: imported`, skipped: `${name}: already present, skipping` },
    );
  }

  logger.info({ ...summary }, `${name} backfill complete`);
  return summary;
}

export async function importItems(
  db: BetterSQLite3Database<typeof schema>,
  items: BookData[],
  seen: Set<string>,
  dedupType: string,
  summary: BackfillSummary,
  context: (item: BookData) => Record<string, unknown>,
  importedMsg: string,
): Promise<void> {
  for (const item of items) {
    const outcome = await importBookData(db, item, seen, dedupType);
    recordImportOutcome(summary, outcome, context(item), { imported: importedMsg });
  }
}
