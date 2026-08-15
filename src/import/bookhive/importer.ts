import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ActorIdentifier } from '@atcute/lexicons/syntax';
import { Client, simpleFetchHandler } from '@atcute/client';
import { DumpState } from '../../dump/state.js';
import { acquireLock, releaseLock } from '../../dump/lock.js';
import { Reservation } from '../../dump/reservation.js';
import { mergeEntity } from '../merge.js';
import { mapCatalogBook, type BookhiveCatalogBook } from './mapper.js';
import { BOOKHIVE_CATALOG_NSID, bookhiveCatalogDid, bookhivePdsUrl } from './constants.js';
import { withRetry } from './network.js';
import { logger } from '../../logger.js';

export interface BookhiveImportOptions {
  db: BetterSQLite3Database;
  reset?: boolean;
  limit?: number;
  lockPath?: string;
}

const STATE_NAME = 'bookhive-catalog';

export interface BookhiveImportResult {
  processed: number;
  failed: number;
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
    acquired = reservation.acquire();
    if (!acquired) {
      const msg = reservation.isHeld()
        ? 'bookhive catalog reservation held by another run'
        : 'database busy; is another import running?';
      logger.warn(msg);
      throw new Error(msg);
    }

    const state = new DumpState(opts.db, STATE_NAME);
    if (opts.reset) state.clear();
    const existing = state.get();
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

    let processed = 0;
    let failed = 0;
    let pages = 0;
    let nextCursor: string | null = cursor;
    do {
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
          for (const c of cands) mergeEntity(opts.db, c);
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
      state.set({ lastKeyCursor: nextCursor });
    } while (nextCursor);

    state.markComplete();
    logger.info({ processed, failed, pages }, 'bookhive catalog import complete');
    return { processed, failed };
  } finally {
    if (acquired) reservation.release();
    releaseLock(lockPath);
  }
}
