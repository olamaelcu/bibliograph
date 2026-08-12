/**
 * Authors-dump batched importer + orchestrator.
 *
 * Mirrors the structure of `src/dump/index.ts` for the editions dump, but is
 * bespoke because the contributor upsert path differs from the book insert path
 * (lookup-then-merge vs plain insert). We do NOT reuse `BatchedImporter`
 * because its writer is BookData-shaped; instead this module drives its own
 * batch loop and delegates the per-batch DB work to `upsert.ts`.
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema.js';
import type { BackfillSummary } from '../../backfill-import.js';
import { DumpState } from '../state.js';
import { HttpDownloader } from '../downloader.js';
import { toContributorRecord, type ContributorRecord } from './mapper.js';
import { AuthorStreamer, SeekError, parseAuthorId } from './streamer.js';
import { upsertAuthorBatch } from './upsert.js';
import { acquireReservation, heartbeatReservation, releaseReservation } from '../reservation.js';
import { logger } from '../../logger.js';

export interface RunAuthorsOptions {
  db: BetterSQLite3Database<typeof schema>;
  state: DumpState;
  downloader: HttpDownloader;
  gzPath: string;
  stateName: string;
  url?: string;
  lastModified?: string | null;
  fileSize?: number | null;
  batchSize?: number;
  streamFactory?: (path: string) => AuthorStreamer;
  signal?: AbortSignal;
}

interface RunAuthorsContext {
  db: BetterSQLite3Database<typeof schema>;
  state: DumpState;
  gzPath: string;
  stateName: string;
  url: string;
  lastModified: string | null;
  fileSize: number | null;
  batchSize: number;
  streamFactory: (path: string) => AuthorStreamer;
  signal?: AbortSignal;
}

const OL_AUTHORS_DUMP_URL_DEFAULT =
  process.env.OL_AUTHORS_DUMP_URL ?? 'https://openlibrary.org/data/ol_dump_authors_latest.txt.gz';
const BATCH_LOG_INTERVAL = Math.max(
  1,
  Number.parseInt(process.env.OL_DUMP_BATCH_LOG_INTERVAL ?? '1', 10) || 1,
);

export async function runAuthorsDumpImport(opts: RunAuthorsOptions): Promise<BackfillSummary> {
  const ctx: RunAuthorsContext = {
    db: opts.db,
    state: opts.state,
    gzPath: opts.gzPath,
    stateName: opts.stateName,
    url: opts.url ?? OL_AUTHORS_DUMP_URL_DEFAULT,
    lastModified: opts.lastModified ?? null,
    fileSize: opts.fileSize ?? null,
    batchSize: opts.batchSize ?? 500,
    streamFactory: opts.streamFactory ?? ((p) => new AuthorStreamer(p)),
    signal: opts.signal,
  };

  acquireReservation(ctx.db, { stateName: ctx.stateName, batchSize: ctx.batchSize });
  try {
    return await runWithContext(ctx);
  } finally {
    releaseReservation(ctx.db, ctx.stateName);
  }
}

async function runWithContext(ctx: RunAuthorsContext): Promise<BackfillSummary> {
  heartbeatReservation(ctx.db, ctx.stateName);

  const existing = ctx.state.get();
  const urlMatches = existing?.url === undefined || existing.url === ctx.url;
  const sizeMatches = ctx.fileSize === null || existing?.fileSize === ctx.fileSize;
  const lastModKnown = existing?.lastModified !== null && existing?.lastModified !== undefined;
  const isFresh = existing?.complete
    && urlMatches
    && sizeMatches
    && lastModKnown
    && existing.lastModified === ctx.lastModified;
  if (isFresh) {
    logger.info({ stateName: ctx.stateName }, 'authors dump up to date; nothing to do');
    return { imported: 0, skipped: existing.totalProcessed, notFound: 0, failed: 0 };
  }

  const streamer = ctx.streamFactory(ctx.gzPath);
  const buffer: ContributorRecord[] = [];
  const summary: BackfillSummary = { imported: 0, skipped: 0, notFound: 0, failed: 0 };
  const seen = new Set<string>();
  const initialStartOffset = existing?.lastByteOffset ?? 0;
  const initialNumericCursor = existing?.lastNumericCursor ?? null;
  let seekFailed = false;
  let aborted = false;
  let lastKey: string | null = existing?.lastKeyCursor ?? null;
  let lastId: number | null = initialNumericCursor;
  let lastByte: number | null = initialStartOffset;
  let batchNumber = 0;
  const runStartTime = Date.now();

  logger.info(
    {
      stateName: ctx.stateName,
      startByteOffset: initialStartOffset,
      resumeCursor: lastKey,
      fileSize: streamer.fileSize(),
      batchSize: ctx.batchSize,
      batchLogInterval: BATCH_LOG_INTERVAL,
    },
    'authors dump import: starting stream',
  );

  const streamOnce = async () => {
    for await (const item of streamer.iter({ startByteOffset: lastByte ?? 0, lastNumericCursor: lastId })) {
      if (ctx.signal?.aborted) {
        logger.warn({ stateName: ctx.stateName }, 'authors dump import: signal received; aborting');
        aborted = true;
        return;
      }
      const mapped = toContributorRecord(item.record);
      if (!mapped) continue;
      buffer.push(mapped);
      lastKey = item.record.key;
      lastId = parseAuthorId(lastKey);
      lastByte = item.byteOffset;
      if (buffer.length >= ctx.batchSize) {
        batchNumber += 1;
        await flushBatch(ctx.db, ctx.state, buffer, seen, summary, lastKey, lastId, lastByte, ctx.stateName, batchNumber, runStartTime);
      }
    }
  };

  try {
    if (initialStartOffset >= streamer.fileSize()) {
      throw new SeekError(
        `byte offset ${initialStartOffset} exceeds dump file size ${streamer.fileSize()}`,
      );
    }
    await streamOnce();
  } catch (err) {
    if (err instanceof SeekError) {
      logger.warn(
        { stateName: ctx.stateName, err: (err as Error).message },
        'byte-offset seek failed; falling back to replay',
      );
      seekFailed = true;
    } else {
      throw err;
    }
  }

  if (seekFailed) {
    summary.skipped += existing?.totalProcessed ?? 0;
    buffer.length = 0;
    lastByte = 0;
    lastId = initialNumericCursor;
    await streamOnce();
  }

  if (aborted) {
    logger.warn({ stateName: ctx.stateName, summary }, 'authors dump import: aborted; checkpoint preserved');
    return summary;
  }

  if (buffer.length > 0) {
    batchNumber += 1;
    await flushBatch(ctx.db, ctx.state, buffer, seen, summary, lastKey, lastId, lastByte, ctx.stateName, batchNumber, runStartTime);
  }

  ctx.state.markComplete();
  ctx.state.set({
    lastKeyCursor: lastKey,
    lastNumericCursor: lastId,
    lastByteOffset: streamer.fileSize(),
  });
  logger.info({ stateName: ctx.stateName, ...summary }, 'authors dump import complete');
  return summary;
}

async function flushBatch(
  db: BetterSQLite3Database<typeof schema>,
  state: DumpState,
  buffer: ContributorRecord[],
  seen: Set<string>,
  summary: BackfillSummary,
  lastKey: string | null,
  lastId: number | null,
  lastByte: number | null,
  stateName: string,
  batchNumber: number,
  runStartTime: number,
): Promise<void> {
  const batchInputSize = buffer.length;
  const batchStart = Date.now();
  const slice = buffer.splice(0);
  const olKeysInBatch = slice
    .map((r) => r.identifiers.find((i) => i.type === 'openlibrary')?.value)
    .filter((v): v is string => Boolean(v));
  for (const key of olKeysInBatch) seen.add(key);

  try {
    heartbeatReservation(db, stateName);
  } catch (err) {
    logger.warn({ err, stateName }, 'authors dump import: reservation heartbeat failed');
  }

  let attempt = 0;
  let flushed: BackfillSummary;
  while (attempt < 2) {
    try {
      flushed = upsertAuthorBatch(db, slice);
      break;
    } catch (err) {
      attempt += 1;
      if (attempt >= 2) {
        logger.fatal(
          { err, stateName, lastKey, batch: batchNumber },
          'authors dump import: batch failed twice; aborting without cursor advance',
        );
        throw err;
      }
      logger.warn(
        { err, count: slice.length, attempt },
        'authors dump import: transaction failed; retrying once',
      );
    }
  }

  summary.imported += flushed!.imported;
  summary.skipped += flushed!.skipped;
  summary.failed += flushed!.failed;
  summary.notFound += flushed!.notFound;

  state.set({
    lastKeyCursor: lastKey,
    lastNumericCursor: lastId,
    lastByteOffset: lastByte ?? 0,
    totalProcessed: (state.get()?.totalProcessed ?? 0) + flushed!.imported,
  });

  if (batchNumber % BATCH_LOG_INTERVAL === 0) {
    const now = Date.now();
    logger.info(
      {
        stateName,
        batch: {
          n: batchNumber,
          size: batchInputSize,
          imported: flushed!.imported,
          skipped: flushed!.skipped,
          failed: flushed!.failed,
          durationMs: now - batchStart,
        },
        cumulative: {
          imported: summary.imported,
          skipped: summary.skipped,
          failed: summary.failed,
          notFound: summary.notFound,
          lastKey,
          lastNumericCursor: lastId,
          lastByteOffset: lastByte,
        },
        elapsedSec: Math.round((now - runStartTime) / 1000),
      },
      `authors dump import: batch ${batchNumber} flushed (${flushed!.imported} new, ${flushed!.skipped} dup, ${flushed!.failed} failed)`,
    );
  }
}
