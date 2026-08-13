import { eq, isNull } from 'drizzle-orm';
import { db, schema, withWriteRetry } from '../db/connection.js';
import { cidForRecord } from '../pds/cid.js';
import {
  serializeBook,
  serializeContributor,
  serializeContributorType,
  type BookRecordValue,
  type ContributorRecordValue,
  type ContributorTypeRecordValue,
} from '../pds/records.js';
import { logger } from '../logger.js';

const { books, contributors, contributorTypes } = schema;

interface BackfillSummary {
  booksScanned: number;
  booksUpdated: number;
  contributorsScanned: number;
  contributorsUpdated: number;
  contributorTypesScanned: number;
  contributorTypesUpdated: number;
  errors: number;
}

type Serialized =
  | BookRecordValue
  | ContributorRecordValue
  | ContributorTypeRecordValue;

interface TableConfig<T extends { uri: string; cid: string | null }> {
  name: string;
  rows: (fn: (row: T) => void) => void;
  pickBatch: (batchSize: number) => T[];
  serialize: (row: T) => Serialized;
  countKey: 'booksScanned' | 'contributorsScanned' | 'contributorTypesScanned';
  updateKey: 'booksUpdated' | 'contributorsUpdated' | 'contributorTypesUpdated';
}

const DEFAULT_BATCH_SIZE = 500;

/**
 * One-shot backfill: compute DAG-CBOR CIDs for every AppView-owned row
 * (book / contributor / contributorType) and persist them in the `cid`
 * column. Idempotent — re-running the script only updates rows whose CID
 * is NULL.
 *
 * Memory-safe on huge tables: rows are pulled one batch at a time
 * (`WHERE cid IS NULL ... LIMIT :batchSize`), so this works on the
 * multi-million-row production books table without loading it all into
 * RAM. Each batch is a single retryable write.
 *
 * NOTE: the read path (`getRecord` / `listRecords` in src/api/pds.ts)
 * already computes CIDs on the fly when `cid` is NULL, so running this
 * backfill is purely an optimization (persisting the cache) — it is NOT
 * required for records to be resolvable.
 *
 * CLI: `tsx src/dump/cli.ts backfill-pds-cids [--dry-run] [--batch-size=N]`
 */
export async function backfillPdsCids(
  opts: { dryRun?: boolean; batchSize?: number } = {},
): Promise<BackfillSummary> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));

  const summary: BackfillSummary = {
    booksScanned: 0,
    booksUpdated: 0,
    contributorsScanned: 0,
    contributorsUpdated: 0,
    contributorTypesScanned: 0,
    contributorTypesUpdated: 0,
    errors: 0,
  };

  await backfillTable({
    name: 'books',
    serialize: serializeBook,
    summary,
    opts,
    batchSize,
    pickBatch: (n) =>
      db
        .select()
        .from(books)
        .where(isNull(books.cid))
        .limit(n)
        .all() as T_BookRow[],
    updateRows: (rows) => {
      for (const { row, cid } of rows) {
        db.update(books).set({ cid }).where(eq(books.uri, row.uri)).run();
      }
    },
    countKey: 'booksScanned',
    updateKey: 'booksUpdated',
  });

  await backfillTable({
    name: 'contributors',
    serialize: serializeContributor,
    summary,
    opts,
    batchSize,
    pickBatch: (n) =>
      db
        .select()
        .from(contributors)
        .where(isNull(contributors.cid))
        .limit(n)
        .all() as T_ContributorRow[],
    updateRows: (rows) => {
      for (const { row, cid } of rows) {
        db.update(contributors).set({ cid }).where(eq(contributors.uri, row.uri)).run();
      }
    },
    countKey: 'contributorsScanned',
    updateKey: 'contributorsUpdated',
  });

  await backfillTable({
    name: 'contributor_types',
    serialize: serializeContributorType,
    summary,
    opts,
    batchSize,
    pickBatch: (n) =>
      db
        .select()
        .from(contributorTypes)
        .where(isNull(contributorTypes.cid))
        .limit(n)
        .all() as T_TypeRow[],
    updateRows: (rows) => {
      for (const { row, cid } of rows) {
        db.update(contributorTypes).set({ cid }).where(eq(contributorTypes.uri, row.uri)).run();
      }
    },
    countKey: 'contributorTypesScanned',
    updateKey: 'contributorTypesUpdated',
  });

  logger.info(summary, 'backfill-pds-cids complete');
  return summary;
}

type T_BookRow = typeof books.$inferSelect;
type T_ContributorRow = typeof contributors.$inferSelect;
type T_TypeRow = typeof contributorTypes.$inferSelect;

interface BackfillTableArgs<T extends { uri: string; cid: string | null }> {
  name: string;
  summary: BackfillSummary;
  opts: { dryRun?: boolean };
  batchSize: number;
  pickBatch: (batchSize: number) => T[];
  updateRows: (updates: Array<{ row: T; cid: string }>) => void;
  serialize: (row: T) => Serialized;
  countKey: 'booksScanned' | 'contributorsScanned' | 'contributorTypesScanned';
  updateKey: 'booksUpdated' | 'contributorsUpdated' | 'contributorTypesUpdated';
}

async function backfillTable<T extends { uri: string; cid: string | null }>(
  args: BackfillTableArgs<T>,
): Promise<void> {
  const { name, summary, opts, batchSize, pickBatch, updateRows, serialize } = args;
  const { dryRun } = opts;

  for (;;) {
    // Pull one bounded batch of rows still missing a CID. Rows updated in a
    // previous iteration drop out of the `cid IS NULL` predicate, so the
    // next batch naturally advances. `LIMIT` alone gives us a stable
    // cursor because we never mutate the predicate between iterations.
    const batch = pickBatch(batchSize);
    if (batch.length === 0) break;

    const updates: Array<{ row: T; cid: string }> = [];
    for (const row of batch) {
      try {
        updates.push({ row, cid: await cidForRecord(serialize(row)) });
        summary[args.countKey]++;
      } catch (err) {
        summary.errors++;
        logger.error({ err, uri: row.uri }, `backfill-pds-cids: ${name} failed`);
      }
    }

    if (dryRun) {
      summary[args.updateKey] += updates.length;
      continue;
    }

    try {
      await withWriteRetry(() => {
        updateRows(updates);
        return updates.length;
      });
      summary[args.updateKey] += updates.length;
    } catch (err) {
      summary.errors += updates.length;
      logger.error(
        { err, table: name, batchSize: updates.length },
        `backfill-pds-cids: ${name} batch update failed`,
      );
    }
  }
}