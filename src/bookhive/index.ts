import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { logger } from '../logger.js';
import { BookhiveCatalogState } from './state.js';
import { BookhiveStreamer, type ListRecordsFn } from './streamer.js';
import {
  bookhiveUserBookToReadingStatus,
  catalogBookToBookData,
  type BookhiveCatalogRecord,
  type BookhiveUserBookRecord,
} from './mapper.js';
import { importBookhiveCatalogBook, importUserBookRecord } from './importer.js';

export interface BookhiveRunOptions {
  state: BookhiveCatalogState;
  catalogDid: string;
  pdsUrl: string;
  pageSize?: number;
  batchSize?: number;
  listRecords?: ListRecordsFn;
  signal?: AbortSignal;
  batchCheckpoint?: () => void;
}

export interface BookhiveRunSummary {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  aborted: boolean;
}

interface ImportCounters {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_BATCH_SIZE = 500;

export async function runCatalogImport(
  db: BetterSQLite3Database<typeof schema>,
  opts: BookhiveRunOptions,
): Promise<BookhiveRunSummary> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  const existing = opts.state.get();
  if (existing?.complete) {
    return {
      imported: 0,
      updated: 0,
      skipped: existing.totalProcessed,
      failed: 0,
      aborted: false,
    };
  }

  const resumeCursor = existing?.lastRkey ?? undefined;
  const counters: ImportCounters = {
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };
  let buffered: Array<ReturnType<typeof catalogBookToBookData>> = [];
  let lastRkey: string | null = existing?.lastRkey ?? null;
  let aborted = false;
  const runStart = Date.now();

  opts.state.set({
    catalogDid: opts.catalogDid,
    lastRkey,
    totalProcessed: existing?.totalProcessed ?? 0,
  });

  const streamer = new BookhiveStreamer({
    pdsUrl: opts.pdsUrl,
    repoDid: opts.catalogDid,
    collection: 'buzz.bookhive.catalogBook',
    pageSize,
    listRecords: opts.listRecords as ListRecordsFn,
  });

  logger.info(
    {
      catalogDid: opts.catalogDid,
      pdsUrl: opts.pdsUrl,
      pageSize,
      batchSize,
      resumeCursor: resumeCursor ?? null,
    },
    'bookhive import: starting',
  );

  try {
    for await (const item of streamer.iter({ resumeCursor })) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      const mapped = catalogBookToBookData(item.record as unknown as BookhiveCatalogRecord);
      buffered.push(mapped);
      lastRkey = item.rkey;

      if (buffered.length >= batchSize) {
        await flushBuffered(db, opts.state, buffered.splice(0), counters, lastRkey, opts.catalogDid, opts.batchCheckpoint);
        if (opts.signal?.aborted) {
          aborted = true;
          break;
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'bookhive import: streaming failed; preserving checkpoint');
    return {
      imported: counters.imported,
      updated: counters.updated,
      skipped: counters.skipped,
      failed: counters.failed + 1,
      aborted: true,
    };
  }

  if (buffered.length > 0) {
    await flushBuffered(db, opts.state, buffered.splice(0), counters, lastRkey, opts.catalogDid, opts.batchCheckpoint);
  }

  if (aborted || opts.signal?.aborted) {
    logger.warn(
      { counters, lastRkey },
      'bookhive import: aborted; checkpoint preserved',
    );
    return { ...counters, aborted: true };
  }

  opts.state.markComplete();
  opts.state.set({ lastRkey: null, totalProcessed: counters.imported + counters.updated });
  logger.info(
    { counters, durationMs: Date.now() - runStart },
    'bookhive import: complete',
  );
  return { ...counters, aborted: false };
}

async function flushBuffered(
  db: BetterSQLite3Database<typeof schema>,
  state: BookhiveCatalogState,
  batch: Array<ReturnType<typeof catalogBookToBookData>>,
  counters: ImportCounters,
  lastRkey: string | null,
  catalogDid: string,
  batchCheckpoint?: () => void,
): Promise<void> {
  let importedInBatch = 0;
  let updatedInBatch = 0;

  for (const mapped of batch) {
    if (skippedByHiveId(db, mapped.hiveId)) {
      counters.skipped += 1;
      continue;
    }
    const result = importBookhiveCatalogBook(db, mapped);
    if (result.action === 'inserted') {
      counters.imported += 1;
      importedInBatch += 1;
    } else if (result.action === 'updated') {
      counters.updated += 1;
      updatedInBatch += 1;
    } else {
      counters.failed += 1;
    }
  }

  state.set({
    catalogDid,
    lastRkey,
    totalProcessed:
      (state.get()?.totalProcessed ?? 0) + importedInBatch + updatedInBatch,
  });

  batchCheckpoint?.();
}

function skippedByHiveId(
  db: BetterSQLite3Database<typeof schema>,
  hiveId: string,
): boolean {
  const row = db
    .select({ uri: schema.books.uri })
    .from(schema.books)
    .where(
      sql`EXISTS (SELECT 1 FROM json_each(${schema.books.identifiers}) je WHERE json_extract(je.value, '$.type') = 'hiveId' AND json_extract(je.value, '$.value') = ${hiveId})`,
    )
    .get();
  return row !== undefined;
}

export interface UserBackfillOptions {
  pageSize?: number;
  listRecords?: ListRecordsFn;
  pdsUrlForDid: (did: string) => Promise<string>;
  onUserState?: (did: string, cursor: string | null) => void;
  signal?: AbortSignal;
}

export interface UserBackfillSummary {
  usersProcessed: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  aborted: boolean;
}

/**
 * Backfill reading statuses for every user in bookhive_user_discovery.
 * Each user's `buzz.bookhive.book` records stream through the shared
 * importUserBookRecord. A failing user is logged and skipped; the run
 * continues with the next.
 */
export async function runUserBackfill(
  db: BetterSQLite3Database<typeof schema>,
  opts: UserBackfillOptions,
): Promise<UserBackfillSummary> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const users = db.select().from(schema.bookhiveUserDiscovery).all();
  const summary: UserBackfillSummary = {
    usersProcessed: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    aborted: false,
  };

  logger.info({ userCount: users.length }, 'bookhive user backfill: starting');

  for (const user of users) {
    if (opts.signal?.aborted) {
      summary.aborted = true;
      break;
    }
    summary.usersProcessed += 1;

    let pdsUrl: string;
    try {
      pdsUrl = await opts.pdsUrlForDid(user.did);
    } catch (err) {
      logger.warn({ did: user.did, err }, 'bookhive user backfill: pds resolution failed');
      db.update(schema.bookhiveUserDiscovery)
        .set({ lastError: (err as Error).message.slice(0, 500) })
        .where(eq(schema.bookhiveUserDiscovery.did, user.did))
        .run();
      summary.failed += 1;
      continue;
    }

    try {
      const streamer = new BookhiveStreamer({
        pdsUrl,
        repoDid: user.did,
        collection: 'buzz.bookhive.book',
        pageSize,
        listRecords: opts.listRecords as ListRecordsFn,
      });

      for await (const item of streamer.iter()) {
        if (opts.signal?.aborted) {
          summary.aborted = true;
          break;
        }
        const mapped = bookhiveUserBookToReadingStatus(
          item.record as unknown as BookhiveUserBookRecord,
          { userDid: user.did },
        );
        const result = importUserBookRecord(db, mapped, {
          sourceUri: item.uri,
        });
        if (result.action === 'inserted') summary.imported += 1;
        else if (result.action === 'updated') summary.updated += 1;
        else if (result.action === 'skipped') summary.skipped += 1;
        else summary.failed += 1;
        opts.onUserState?.(user.did, item.rkey);
      }
    } catch (err) {
      logger.warn(
        { did: user.did, err },
        'bookhive user backfill: failed; continuing to next user',
      );
      db.update(schema.bookhiveUserDiscovery)
        .set({ lastError: (err as Error).message.slice(0, 500) })
        .where(eq(schema.bookhiveUserDiscovery.did, user.did))
        .run();
      summary.failed += 1;
      continue;
    }
  }

  logger.info({ ...summary }, 'bookhive user backfill: complete');
  return summary;
}
