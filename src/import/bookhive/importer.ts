import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import type { ActorIdentifier } from '@atcute/lexicons/syntax';
import { Client, simpleFetchHandler } from '@atcute/client';
import { DumpState } from '../../dump/state.js';
import { acquireLock, releaseLock } from '../../dump/lock.js';
import { Reservation } from '../../dump/reservation.js';
import { mergeEntity } from '../merge.js';
import { hydrateBookContributorsByName } from '../book-contributors.js';
import { mapCatalogBook, catalogAuthorNames, type BookhiveCatalogBook } from './mapper.js';
import { BOOKHIVE_CATALOG_NSID, bookhiveCatalogDid, bookhivePdsUrl } from './constants.js';
import { withRetry } from './network.js';
import { logger } from '../../logger.js';

type Database = NodePgDatabase<typeof schema>;

export interface BookhiveImportOptions {
  db: Database;
  reset?: boolean;
  limit?: number;
  lockPath?: string;
  /** Abort: stop between pages and mark the run stopped. */
  signal?: AbortSignal;
}

const STATE_NAME = 'bookhive-catalog';

export interface BookhiveImportResult {
  processed: number;
  failed: number;
}

/**
 * Read-only pre-count pass: walks every page of the catalog from the given
 * cursor and sums the record counts, so we can report progress against a known
 * total. Returns null if interrupted partway (a partial count is useless).
 */
async function countCatalogRecords(
  rpc: Client,
  did: string,
  startCursor: string | null,
  opts: { signal?: AbortSignal; limit?: number },
): Promise<number | null> {
  let total = 0;
  let nextCursor: string | null = startCursor;
  do {
    if (opts.signal?.aborted) {
      logger.info({ counted: total }, 'bookhive count interrupted');
      return null;
    }
    const res = await withRetry(
      'bookhive listRecords failed',
      () =>
        rpc.get('com.atproto.repo.listRecords', {
          params: {
            repo: did as ActorIdentifier,
            collection: BOOKHIVE_CATALOG_NSID,
            limit: opts.limit ?? 100,
            cursor: nextCursor ?? undefined,
          },
        }),
      { cursor: nextCursor ?? null },
    );
    if (!res.ok) {
      const where = nextCursor ?? 'start';
      throw new Error(
        `bookhive listRecords failed (cursor ${where}): ${res.data.error}${res.data.message ? `: ${res.data.message}` : ''}`,
      );
    }
    total += res.data.records.length;
    nextCursor = res.data.cursor ?? null;
  } while (nextCursor);
  return total;
}

export async function importBookhiveCatalog(opts: BookhiveImportOptions): Promise<BookhiveImportResult> {
  const lockPath = opts.lockPath ?? 'data/bookhive-catalog.lock';
  if (!acquireLock(lockPath)) {
    logger.warn('bookhive catalog lock held; aborting');
    throw new Error('bookhive catalog lock held');
  }
  const reservation = new Reservation(opts.db, STATE_NAME);
  let acquired = false;
  try {
    acquired = await reservation.acquire();
    if (!acquired) {
      const msg = (await reservation.isHeld())
        ? 'bookhive catalog reservation held by another run'
        : 'database busy; is another import running?';
      logger.warn(msg);
      throw new Error(msg);
    }

    const state = new DumpState(opts.db, STATE_NAME);
    if (opts.reset) await state.clear();
    const existing = await state.get();
    if (existing?.complete) {
      logger.info('bookhive catalog already complete; use --reset to re-import');
      return { processed: 0, failed: 0 };
    }
    const cursor = existing?.cursor ?? null;

    const rpc = new Client({ handler: simpleFetchHandler({ service: bookhivePdsUrl() }) });
    const did = bookhiveCatalogDid();

    logger.info(
      { pds: bookhivePdsUrl(), did, collection: BOOKHIVE_CATALOG_NSID, cursor },
      'starting bookhive catalog import',
    );

    const baseProcessed = existing?.totalProcessed ?? 0;

    // Pre-count the catalog once so progress can be reported against a known
    // total (and an ETA derived). Skipped when a prior run already stored the
    // total, so resumes don't re-walk the collection.
    if (existing?.totalRecords == null) {
      const counted = await countCatalogRecords(rpc, did, cursor, { signal: opts.signal, limit: opts.limit });
      if (counted === null) {
        await state.set({ stopped: true });
        logger.info('bookhive count interrupted before import; run stopped');
        return { processed: 0, failed: 0 };
      }
      await state.set({ totalRecords: baseProcessed + counted });
      logger.info({ totalRecords: baseProcessed + counted }, 'bookhive catalog pre-counted records');
    }

    let processed = 0;
    let failed = 0;
    let pages = 0;
    let nextCursor: string | null = cursor;
    do {
      if (opts.signal?.aborted) {
        await state.set({ stopped: true, totalProcessed: baseProcessed + processed });
        logger.info({ processed, failed, pages, cursor: nextCursor }, 'bookhive import stopped by interrupt');
        return { processed, failed };
      }
      logger.info({ processed, failed, pages }, 'fetching records from listRecords');
      const res = await withRetry(
        'bookhive listRecords failed',
        () =>
          rpc.get('com.atproto.repo.listRecords', {
            params: {
              repo: did as ActorIdentifier,
              collection: BOOKHIVE_CATALOG_NSID,
              limit: opts.limit ?? 100,
              cursor: nextCursor ?? undefined,
            },
          }),
        { cursor: nextCursor ?? null },
      );

      if (!res.ok) {
        const where = nextCursor ?? 'start';
        throw new Error(
          `bookhive listRecords failed (cursor ${where}): ${res.data.error}${res.data.message ? `: ${res.data.message}` : ''}`,
        );
      }
      const body = res.data;
      for (const record of body.records) {
        try {
          const cands = mapCatalogBook(record.value as BookhiveCatalogBook);
          let bookPk: string | null = null;
          for (const c of cands) {
            const res = await mergeEntity(opts.db, c);
            if (c.entityType === 'book') bookPk = res.pk;
          }
          // Link the merged book to its authors (BookHive catalogs authors by name).
          if (bookPk) {
            const names = catalogAuthorNames(record.value as BookhiveCatalogBook);
            if (names.length > 0) await hydrateBookContributorsByName(opts.db, bookPk, names);
          }
        } catch (err) {
          failed += 1;
          logger.warn({ err: (err as Error).message, uri: record.uri }, 'bookhive record failed');
        }
        processed += 1;
      }

      pages += 1;
      logger.debug({ cursor: nextCursor ?? null, records: body.records.length, next: body.cursor ?? null }, 'bookhive page fetched');
      if (pages % 50 === 0) {
        logger.info({ pages, processed, failed }, 'bookhive catalog import progress');
      }

      nextCursor = body.cursor ?? null;
      await state.set({ lastKeyCursor: nextCursor, totalProcessed: baseProcessed + processed });
    } while (nextCursor);

    await state.markComplete();
    logger.info({ processed, failed, pages }, 'bookhive catalog import complete');
    return { processed, failed };
  } finally {
    if (acquired) await reservation.release();
    releaseLock(lockPath);
  }
}
