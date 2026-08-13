import { eq, isNull } from 'drizzle-orm';
import { db, schema, withWriteRetry } from '../db/connection.js';
import { cidForRecord } from '../pds/cid.js';
import {
  serializeBook,
  serializeContributor,
  serializeContributorType,
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

/**
 * One-shot backfill: compute DAG-CBOR CIDs for every AppView-owned row
 * (book / contributor / contributorType) and persist them in the `cid`
 * column. Idempotent — re-running the script only updates rows whose CID
 * is NULL.
 *
 * CLI: `tsx src/dump/cli.ts backfill-pds-cids [--dry-run]`
 */
export async function backfillPdsCids(opts: { dryRun?: boolean } = {}): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    booksScanned: 0,
    booksUpdated: 0,
    contributorsScanned: 0,
    contributorsUpdated: 0,
    contributorTypesScanned: 0,
    contributorTypesUpdated: 0,
    errors: 0,
  };

  const booksMissing = db
    .select()
    .from(books)
    .where(isNull(books.cid))
    .all();
  summary.booksScanned = booksMissing.length;
  for (const row of booksMissing) {
    try {
      const cid = await cidForRecord(serializeBook(row));
      if (!opts.dryRun) {
        await withWriteRetry(() =>
          db.update(books).set({ cid }).where(eq(books.uri, row.uri)),
        );
      }
      summary.booksUpdated++;
    } catch (err) {
      summary.errors++;
      logger.error({ err, uri: row.uri }, 'backfill-pds-cids: book failed');
    }
  }

  const contribsMissing = db
    .select()
    .from(contributors)
    .where(isNull(contributors.cid))
    .all();
  summary.contributorsScanned = contribsMissing.length;
  for (const row of contribsMissing) {
    try {
      const cid = await cidForRecord(serializeContributor(row));
      if (!opts.dryRun) {
        await withWriteRetry(() =>
          db.update(contributors).set({ cid }).where(eq(contributors.uri, row.uri)),
        );
      }
      summary.contributorsUpdated++;
    } catch (err) {
      summary.errors++;
      logger.error({ err, uri: row.uri }, 'backfill-pds-cids: contributor failed');
    }
  }

  const typesMissing = db
    .select()
    .from(contributorTypes)
    .where(isNull(contributorTypes.cid))
    .all();
  summary.contributorTypesScanned = typesMissing.length;
  for (const row of typesMissing) {
    try {
      const cid = await cidForRecord(serializeContributorType(row));
      if (!opts.dryRun) {
        await withWriteRetry(() =>
          db.update(contributorTypes).set({ cid }).where(eq(contributorTypes.uri, row.uri)),
        );
      }
      summary.contributorTypesUpdated++;
    } catch (err) {
      summary.errors++;
      logger.error({ err, uri: row.uri }, 'backfill-pds-cids: contributorType failed');
    }
  }

  logger.info(summary, 'backfill-pds-cids complete');
  return summary;
}