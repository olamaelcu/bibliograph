import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { logger } from '../logger.js';
import { abortReason } from './interrupt.js';

type Database = NodePgDatabase<typeof schema>;

export interface BatchSummary {
  processed: number;
  inserted: number;
  skipped: number;
  failed: number;
}

/**
 * Runs a per-record upsert function in transaction batches. Each batch is
 * atomic; a failing record is caught, counted, and skipped so one bad line
 * doesn't abort the whole import. The upsert runs against the transaction
 * handle, so all writes in a batch share one transaction.
 */
export async function importInBatches<T>(
  db: Database,
  items: AsyncGenerator<T, void, void>,
  opts: {
    batchSize?: number;
    logInterval?: number;
    /** Known total record count, used only to compute progress. */
    total?: number;
    /** Called after each flushed batch with cumulative processed + total. */
    onProgress?: (processed: number, total: number | null) => void;
    /** Called after each flushed batch with cumulative processed and the last item of that batch. */
    onCheckpoint?: (processed: number, lastItem: T) => void | Promise<void>;
    /** Called after the batch transaction commits, with the batch that was just flushed. */
    afterBatch?: (batch: T[]) => void | Promise<void>;
    upsert: (tx: Database, item: T) => { action: 'inserted' | 'skipped' | 'failed' } | Promise<{ action: 'inserted' | 'skipped' | 'failed' }>;
    /**
     * Optional batched path: when provided, takes the whole batch inside a
     * single transaction. Returns per-item actions in the same order as
     * `batch`. Use this when the per-record work involves many round-trip
     * SELECTs that can be hoisted to per-batch scope (e.g. OL editions
     * merge hot path). The per-record `upsert` is the default; only set
     * one of them.
     */
    upsertBatch?: (tx: Database, batch: T[]) => Promise<Array<{ action: 'inserted' | 'skipped' | 'failed' }>>;
    /** Abort: stop cleanly at the next batch boundary. */
    signal?: AbortSignal;
  },
): Promise<BatchSummary> {
  const batchSize = opts.batchSize ?? 500;
  const logInterval = opts.logInterval ?? 5_000;
  const summary: BatchSummary = { processed: 0, inserted: 0, skipped: 0, failed: 0 };
  const startedAt = Date.now();

  logger.info({ batchSize, logInterval }, 'import started');
  let batch: T[] = [];

  for await (const item of items) {
    if (opts.signal?.aborted) throw interruptedError(opts.signal);
    batch.push(item);
    summary.processed += 1;
    if (batch.length >= batchSize) {
      const lastItem = batch[batch.length - 1];
      await flushBatch(batch);
      batch = [];
      await checkpoint(lastItem);
      if (opts.signal?.aborted) throw interruptedError(opts.signal);
    }
  }
  if (batch.length) {
    const lastItem = batch[batch.length - 1];
    await flushBatch(batch);
    batch = [];
    await checkpoint(lastItem);
  }
  logger.debug({ ...summary, elapsedMs: Date.now() - startedAt }, 'import final batch flushed');
  return summary;

  async function checkpoint(lastItem: T): Promise<void> {
    await opts.onCheckpoint?.(summary.processed, lastItem);
    opts.onProgress?.(summary.processed, opts.total ?? null);
    if (summary.processed % logInterval === 0) {
      logger.info({ ...summary, elapsedMs: Date.now() - startedAt }, 'import progress');
    }
  }

  async function flushBatch(b: T[]): Promise<void> {
    if (opts.upsertBatch) {
      // Batched path: one transaction per batch, per-record failures
      // must be caught inside upsertBatch (the callback decides how to
      // report failures). The whole batch is rolled back together on
      // an uncaught error.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL synchronous_commit = off`);
        const results = await opts.upsertBatch!(tx, b);
        for (const r of results) {
          if (r.action === 'inserted') summary.inserted += 1;
          else if (r.action === 'skipped') summary.skipped += 1;
          else summary.failed += 1;
        }
      });
    } else {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL synchronous_commit = off`);
        for (const item of b) {
          try {
            // Per-record savepoint: a malformed OL row that violates a NOT NULL
            // or CHECK constraint fails ONLY that record's subtransaction. Without
            // this, Postgres marks the outer transaction aborted and every
            // subsequent query in the same batch returns "current transaction is
            // aborted" until commit, producing a flood of indistinguishable
            // failures that mask the real one.
            const res = await tx.transaction(async (savepoint) => opts.upsert(savepoint, item));
            if (res.action === 'inserted') summary.inserted += 1;
            else if (res.action === 'skipped') summary.skipped += 1;
            else summary.failed += 1;
          } catch (err) {
            summary.failed += 1;
            logger.warn({ err }, 'record failed in batch');
          }
        }
      });
    }
    await opts.afterBatch?.(b);
  }
}

function interruptedError(signal: AbortSignal): Error {
  return abortReason(signal) ?? new Error('import stopped');
}
