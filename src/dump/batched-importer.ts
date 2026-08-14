import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { logger } from '../logger.js';

export interface BatchSummary {
  processed: number;
  inserted: number;
  skipped: number;
  failed: number;
}

/**
 * Runs a per-record upsert function in transaction batches. Each batch is
 * atomic; a failing record is caught, counted, and skipped so one bad line
 * doesn't abort the whole import. The batch function must be synchronous
 * (better-sqlite3 is sync).
 */
export function importInBatches<T>(
  db: BetterSQLite3Database,
  items: AsyncGenerator<T, void, void>,
  opts: {
    batchSize?: number;
    logInterval?: number;
    upsert: (item: T) => { action: 'inserted' | 'skipped' | 'failed' };
  },
): Promise<BatchSummary> {
  const batchSize = opts.batchSize ?? 500;
  const logInterval = opts.logInterval ?? 5_000;
  const summary: BatchSummary = { processed: 0, inserted: 0, skipped: 0, failed: 0 };
  const startedAt = Date.now();

  return (async () => {
    let batch: T[] = [];
    for await (const item of items) {
      batch.push(item);
      summary.processed += 1;
      if (batch.length >= batchSize) {
        flushBatch(batch);
        batch = [];
        if (summary.processed % logInterval === 0) {
          logger.info({ ...summary, elapsedMs: Date.now() - startedAt }, 'import progress');
        }
      }
    }
    if (batch.length) flushBatch(batch);
    return summary;

    function flushBatch(b: T[]): void {
      db.transaction((tx) => {
        for (const item of b) {
          try {
            const res = opts.upsert(item);
            if (res.action === 'inserted') summary.inserted += 1;
            else if (res.action === 'skipped') summary.skipped += 1;
            else summary.failed += 1;
          } catch (err) {
            summary.failed += 1;
            logger.warn({ err: (err as Error).message }, 'record failed in batch');
          }
        }
      });
    }
  })();
}
