/**
 * Retro-backfill: walk `books` rows that were OL-dump-imported (no
 * book_contributors join rows yet) and add the join row that bookhive
 * would otherwise have created.
 *
 * For each candidate book:
 *   1. Read `books.author` and look for an `openlibrary` entry in
 *      `books.identifiers`.
 *   2. Resolve or create the contributor via `findOrComputeContributor`,
 *      which prefers an OL-key match over a case-insensitive name match
 *      and merges the OL key into the contributor's identifiers.
 *   3. Load the 'author' role and INSERT a book_contributors row keyed
 *      (bookUri, contributorUri, roleUri). `onConflictDoNothing` keeps the
 *      command idempotent.
 *
 * Skips books with empty `author` (counted as skippedNoAuthor) and books
 * with no `openlibrary` identifier (counted as skippedNoOlKey). Books
 * that already have any join row are skipped (counted as
 * alreadyHadJoinRows) so the bookhive-imported path is never disturbed.
 */

import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { findOrComputeContributor } from '../bookhive/importer.js';
import { acquireReservation, releaseReservation } from './reservation.js';
import { logger } from '../logger.js';
import { COLLECTIONS } from '../records.js';
import { encode } from '@atcute/cbor';
import { fromDigest, CODEC_DCBOR, toString as cidToString } from '@atcute/cid';
import { createHash } from 'node:crypto';

const HYDRATE_STATE_NAME = 'book_contributors_hydrate';

export interface HydrateSummary {
  booksWalked: number;
  joinRowsCreated: number;
  alreadyHadJoinRows: number;
  skippedNoAuthor: number;
  skippedNoOlKey: number;
  errors: number;
  dryRun: boolean;
  resetDeleted?: number;
}

export interface HydrateOptions {
  dryRun?: boolean;
  reset?: boolean;
}

function recordCid(record: Record<string, unknown>): string {
  const cborBytes = encode(record as never);
  const sha = createHash('sha256').update(cborBytes).digest();
  return cidToString(fromDigest(CODEC_DCBOR, sha));
}

function getOpenLibraryKey(identifiers: unknown): string | null {
  if (!Array.isArray(identifiers)) return null;
  for (const entry of identifiers) {
    if (
      entry &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'openlibrary' &&
      typeof (entry as { value?: unknown }).value === 'string'
    ) {
      return (entry as { value: string }).value;
    }
  }
  return null;
}

function hasJoinRow(db: BetterSQLite3Database<typeof schema>, bookUri: string): boolean {
  const row = db
    .select({ x: sql<number>`1` })
    .from(schema.bookContributors)
    .where(eq(schema.bookContributors.bookUri, bookUri))
    .get();
  return Boolean(row);
}

function loadAuthorRole(
  db: BetterSQLite3Database<typeof schema>,
): { uri: string; cid: string } {
  const row = db
    .select()
    .from(schema.contributorTypes)
    .where(eq(schema.contributorTypes.name, 'author'))
    .get();
  if (!row) {
    throw new Error(
      "author contributor type not found; ensure bootstrapContributorTypes() ran at startup",
    );
  }
  return { uri: row.uri, cid: recordCid({ $type: COLLECTIONS.contributorType, name: row.name, createdAt: row.createdAt }) };
}

export function hydrateBookContributors(
  db: BetterSQLite3Database<typeof schema>,
  opts: HydrateOptions = {},
): HydrateSummary {
  const dryRun = Boolean(opts.dryRun);
  const reset = Boolean(opts.reset);
  const summary: HydrateSummary = {
    booksWalked: 0,
    joinRowsCreated: 0,
    alreadyHadJoinRows: 0,
    skippedNoAuthor: 0,
    skippedNoOlKey: 0,
    errors: 0,
    dryRun,
  };

  acquireReservation(db, { stateName: HYDRATE_STATE_NAME, batchSize: 1 });
  try {
    return hydrateWalk(db, opts, summary);
  } finally {
    releaseReservation(db, HYDRATE_STATE_NAME);
  }
}

function hydrateWalk(
  db: BetterSQLite3Database<typeof schema>,
  opts: HydrateOptions,
  summary: HydrateSummary,
): HydrateSummary {
  const dryRun = summary.dryRun;
  const reset = Boolean(opts.reset);

  if (reset && !dryRun) {
    const result = db.delete(schema.bookContributors).run();
    summary.resetDeleted = result.changes;
    logger.info(
      { reset: true, deleted: result.changes },
      'hydrate:book-contributors reset',
    );
  }

  const allBooks = db.select().from(schema.books).all();
  summary.booksWalked = allBooks.length;

  for (const book of allBooks) {
    try {
      if (!book.author || book.author.trim().length === 0) {
        summary.skippedNoAuthor += 1;
        continue;
      }
      if (hasJoinRow(db, book.uri)) {
        summary.alreadyHadJoinRows += 1;
        continue;
      }
      const olKey = getOpenLibraryKey(book.identifiers);
      if (!olKey) {
        summary.skippedNoOlKey += 1;
        continue;
      }

      if (dryRun) {
        summary.joinRowsCreated += 1;
        continue;
      }

      const result = db.transaction((tx) => {
        const contributor = findOrComputeContributor(tx as never, book.author, { olKey });
        const role = loadAuthorRole(tx as never);
        const inserted = tx
          .insert(schema.bookContributors)
          .values({
            bookUri: book.uri,
            contributorUri: contributor.uri,
            contributorCid: contributor.cid,
            roleUri: role.uri,
            roleCid: role.cid,
            ordering: 0,
          })
          .onConflictDoNothing()
          .run();
        return inserted.changes;
      });
      if (result > 0) summary.joinRowsCreated += 1;
    } catch (err) {
      summary.errors += 1;
      logger.error({ err, uri: book.uri }, 'hydrate:book-contributors failed for book');
    }
  }

  logger.info(summary, 'hydrate:book-contributors complete');
  return summary;
}
