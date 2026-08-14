import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ActorIdentifier } from '@atcute/lexicons/syntax';
import { Client, simpleFetchHandler } from '@atcute/client';
import { DumpState } from '../../dump/state.js';
import { acquireLock, releaseLock } from '../../dump/lock.js';
import { Reservation } from '../../dump/reservation.js';
import { mergeEntity } from '../merge.js';
import { mapCatalogBook, type BookhiveCatalogBook } from './mapper.js';
import { BOOKHIVE_CATALOG_NSID, bookhiveCatalogDid, bookhivePdsUrl } from './constants.js';
import { logger } from '../../logger.js';

export interface BookhiveImportOptions {
  db: BetterSQLite3Database;
  reset?: boolean;
  limit?: number;
  lockPath?: string;
}

const STATE_NAME = 'bookhive-catalog';

export async function importBookhiveCatalog(opts: BookhiveImportOptions): Promise<{ processed: number }> {
  const lockPath = opts.lockPath ?? 'data/bookhive-catalog.lock';
  if (!acquireLock(lockPath)) {
    logger.warn('bookhive catalog lock held; aborting');
    process.exit(1);
  }
  const reservation = new Reservation(opts.db, STATE_NAME);
  reservation.acquire();

  try {
    if (opts.reset) new DumpState(opts.db, STATE_NAME).clear();
    const state = new DumpState(opts.db, STATE_NAME);
    const cursor = state.get()?.cursor ?? null;

    const rpc = new Client({ handler: simpleFetchHandler({ service: bookhivePdsUrl() }) });
    const did = bookhiveCatalogDid();

    let processed = 0;
    let nextCursor: string | null = cursor;
    do {
      const res = await rpc.get('com.atproto.repo.listRecords', {
        params: {
          repo: did as ActorIdentifier,
          collection: BOOKHIVE_CATALOG_NSID,
          limit: opts.limit ?? 100,
          cursor: nextCursor ?? undefined,
        },
      });

      if (!res.ok) {
        throw new Error(`bookhive listRecords failed: ${res.data.error}${res.data.message ? `: ${res.data.message}` : ''}`);
      }
      const body = res.data;
      for (const record of body.records) {
        const cands = mapCatalogBook(record.value as BookhiveCatalogBook);
        for (const c of cands) mergeEntity(opts.db, c);
        processed += 1;
      }

      nextCursor = body.cursor ?? null;
      state.set({ lastKeyCursor: nextCursor });
    } while (nextCursor);

    state.markComplete();
    logger.info({ processed }, 'bookhive catalog import complete');
    return { processed };
  } finally {
    reservation.release();
    releaseLock(lockPath);
  }
}
