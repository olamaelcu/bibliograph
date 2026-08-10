import { db, schema } from './db/connection.js';
import { logger } from './logger.js';

const { books, bookContributors } = schema;

interface InlineContributor {
  contributor?: { uri?: string; cid?: string };
  role?: { uri?: string; cid?: string };
  order?: number;
}

export interface BackfillSummary {
  dryRun: boolean;
  reset: boolean;
  totalBooks: number;
  booksWithContributors: number;
  joinRowsCreated: number;
  errors: number;
  resetDeleted?: number;
}

export interface BackfillOptions {
  dryRun?: boolean;
  reset?: boolean;
}

export function runBackfill(opts: BackfillOptions = {}): BackfillSummary {
  const dryRun = !!opts.dryRun;
  const reset = !!opts.reset;

  let resetDeleted: number | undefined;
  if (reset) {
    const result = db.delete(bookContributors).run();
    resetDeleted = result.changes;
    logger.info({ reset: true, deleted: resetDeleted }, 'backfill:contributors reset');
  }

  const all = db.select().from(books).all();
  let joinRowsCreated = 0;
  let booksWithContributors = 0;
  let errors = 0;

  for (const book of all) {
    let parsed: InlineContributor[];
    try {
      parsed = typeof book.contributors === 'string'
        ? JSON.parse(book.contributors || '[]')
        : (book.contributors ?? []);
    } catch (err) {
      logger.error({ uri: book.uri, err }, 'failed to parse contributors JSON');
      errors++;
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;

    booksWithContributors++;

    for (const entry of parsed) {
      const contributorUri = entry?.contributor?.uri;
      const roleUri = entry?.role?.uri;
      if (!contributorUri || !roleUri) {
        logger.warn({ uri: book.uri, entry }, 'skipping malformed contributor entry');
        errors++;
        continue;
      }

      if (dryRun) {
        joinRowsCreated++;
        continue;
      }

      try {
        const result = db.insert(bookContributors)
          .values({
            bookUri: book.uri,
            contributorUri,
            contributorCid: entry.contributor!.cid ?? '',
            roleUri,
            roleCid: entry.role!.cid ?? '',
            ordering: typeof entry.order === 'number' ? entry.order : 0,
          })
          .onConflictDoNothing()
          .run();
        if (result.changes > 0) joinRowsCreated++;
      } catch (err) {
        logger.error({ uri: book.uri, entry, err }, 'insert failed');
        errors++;
      }
    }
  }

  const summary: BackfillSummary = {
    dryRun,
    reset,
    totalBooks: all.length,
    booksWithContributors,
    joinRowsCreated,
    errors,
  };
  if (resetDeleted !== undefined) summary.resetDeleted = resetDeleted;

  logger.info(summary, 'backfill:contributors complete');
  return summary;
}

function isCliInvocation(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const url = new URL(argv1, 'file://');
    return url.pathname.endsWith('backfill-contributors.ts') || url.pathname.endsWith('backfill-contributors.js');
  } catch {
    return false;
  }
}

if (isCliInvocation()) {
  const dryRun = process.argv.includes('--dry-run');
  const reset = process.argv.includes('--reset');

  let summary: BackfillSummary;
  try {
    summary = runBackfill({ dryRun, reset });
  } catch (err) {
    logger.error({ err }, 'backfill:contributors failed');
    process.exit(1);
  }

  if (summary.errors > 0) {
    process.exit(1);
  }
}
