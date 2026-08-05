import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { logger } from '../logger.js';
import type { BackfillSummary } from '../backfill-import.js';
import { DumpState } from './state.js';
import { HttpDownloader } from './downloader.js';
import { DumpStreamer, SeekError, parseWorkId } from './streamer.js';
import { toBookData } from './edition-mapper.js';
import { BatchedImporter } from './batched-importer.js';

const OL_DUMP_URL_DEFAULT = 'https://openlibrary.org/data/ol_dump_editions_latest.txt.gz';
const MIN_FREE_BYTES_DEFAULT = 12 * 1024 * 1024 * 1024;

export interface RunOptions {
  db: BetterSQLite3Database<typeof schema>;
  state: DumpState;
  downloader: HttpDownloader;
  gzPath: string;
  stateName: string;
  url?: string;
  lastModified?: string | null;
  fileSize?: number | null;
  batchSize?: number;
  minFreeBytes?: number;
  fetchMetadata?: () => Promise<{ lastModified: string | null; contentLength: number | null }>;
  streamFactory?: (path: string) => DumpStreamer;
  importFactory?: (db: BetterSQLite3Database<typeof schema>, batchSize: number) => BatchedImporter;
}

interface RunContext {
  db: BetterSQLite3Database<typeof schema>;
  state: DumpState;
  downloader: HttpDownloader;
  gzPath: string;
  stateName: string;
  url: string;
  lastModified: string | null;
  contentLength: number | null;
  batchSize: number;
  minFreeBytes: number;
  fetchMetadata: () => Promise<{ lastModified: string | null; contentLength: number | null }>;
  streamFactory: (path: string) => DumpStreamer;
  importFactory: (db: BetterSQLite3Database<typeof schema>, batchSize: number) => BatchedImporter;
}

export async function runEditionsDumpImport(opts: RunOptions): Promise<BackfillSummary> {
  const ctx: RunContext = {
    db: opts.db,
    state: opts.state,
    downloader: opts.downloader,
    gzPath: opts.gzPath,
    stateName: opts.stateName,
    url: opts.url ?? OL_DUMP_URL_DEFAULT,
    lastModified: opts.lastModified ?? null,
    contentLength: opts.fileSize ?? null,
    batchSize: opts.batchSize ?? 500,
    minFreeBytes: opts.minFreeBytes ?? MIN_FREE_BYTES_DEFAULT,
    fetchMetadata: opts.fetchMetadata ?? (async () => opts.downloader.headMetadata().then((m) => ({
      lastModified: m.lastModified,
      contentLength: m.contentLength,
    }))),
    streamFactory: opts.streamFactory ?? ((p) => new DumpStreamer(p)),
    importFactory: opts.importFactory ?? ((d, b) => new BatchedImporter(d, { batchSize: b })),
  };

  await assertDiskSpace(ctx.gzPath, ctx.minFreeBytes);
  return runWithContext(ctx);
}

async function runWithContext(ctx: RunContext): Promise<BackfillSummary> {
  if (ctx.lastModified === null) {
    const head = await ctx.fetchMetadata();
    ctx.lastModified = head.lastModified;
    ctx.contentLength = head.contentLength;
  }

  const existing = ctx.state.get();
  if (
    existing?.complete &&
    existing.lastModified === ctx.lastModified
  ) {
    logger.info({ stateName: ctx.stateName }, 'dump up to date; nothing to do');
    return { imported: 0, skipped: existing.totalProcessed, notFound: 0, failed: 0 };
  }

  const streamer = ctx.streamFactory(ctx.gzPath);
  const buffer: NonNullable<ReturnType<typeof toBookData>>[] = [];
  const summary: BackfillSummary = { imported: 0, skipped: 0, notFound: 0, failed: 0 };
  const importer = ctx.importFactory(ctx.db, ctx.batchSize);

  const initialStartOffset = existing?.lastByteOffset ?? 0;
  const initialResumeKey = existing?.lastKeyCursor ?? null;
  const initialNumericCursor = existing?.lastNumericCursor ?? null;
  let seekFailed = false;
  let lastKey: string | null = initialResumeKey;
  let lastId: number | null = initialNumericCursor;
  let lastByte: number | null = initialStartOffset;

  try {
    if (initialStartOffset >= streamer.fileSize()) {
      throw new SeekError(
        `byte offset ${initialStartOffset} exceeds dump file size ${streamer.fileSize()}`,
      );
    }
    for await (const item of streamer.iter({ startByteOffset: initialStartOffset, lastNumericCursor: initialNumericCursor })) {
      const data = toBookData(item.record);
      if (!data) continue;
      buffer.push(data);
      lastKey = item.record.key;
      lastId = parseWorkId(lastKey);
      lastByte = item.byteOffset;
      if (buffer.length >= ctx.batchSize) {
        const flushed = await importer.runAll(buffer.splice(0));
        mergeSummary(summary, flushed);
        ctx.state.set({ lastKeyCursor: lastKey, lastNumericCursor: lastId, lastByteOffset: lastByte ?? 0 });
      }
    }
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
    for await (const item of streamer.iter({ startByteOffset: 0, lastNumericCursor: initialNumericCursor })) {
      const data = toBookData(item.record);
      if (!data) continue;
      buffer.push(data);
      lastKey = item.record.key;
      lastId = parseWorkId(lastKey);
      lastByte = item.byteOffset;
      if (buffer.length >= ctx.batchSize) {
        const flushed = await importer.runAll(buffer.splice(0));
        mergeSummary(summary, flushed);
        ctx.state.set({ lastKeyCursor: lastKey, lastNumericCursor: lastId, lastByteOffset: lastByte ?? 0 });
      }
    }
  }

  if (buffer.length > 0) {
    const flushed = await importer.runAll(buffer.splice(0));
    mergeSummary(summary, flushed);
    ctx.state.set({ lastKeyCursor: lastKey, lastNumericCursor: lastId, lastByteOffset: lastByte ?? 0 });
  }

  ctx.state.markComplete();
  ctx.state.set({
    totalProcessed: summary.imported,
    lastKeyCursor: lastKey,
    lastNumericCursor: lastId,
    lastByteOffset: streamer.fileSize(),
  });
  logger.info({ stateName: ctx.stateName, ...summary }, 'editions dump import complete');
  return summary;
}

function mergeSummary(into: BackfillSummary, from: BackfillSummary): void {
  into.imported += from.imported;
  into.skipped += from.skipped;
  into.notFound += from.notFound;
  into.failed += from.failed;
}

async function assertDiskSpace(path: string, minFreeBytes: number): Promise<void> {
  const stats = await statfs(dirname(path));
  if (stats.bavail * stats.bsize < minFreeBytes) {
    throw new Error(
      `insufficient disk space at ${dirname(path)}: ${stats.bavail * stats.bsize} available, need ${minFreeBytes}`,
    );
  }
}
