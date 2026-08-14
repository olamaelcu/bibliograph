import { resolve } from 'node:path';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DumpState } from '../dump/state.js';
import { DumpStreamer, SeekError } from '../dump/streamer.js';
import { HttpDownloader } from '../dump/downloader.js';
import { acquireLock, releaseLock } from '../dump/lock.js';
import { Reservation } from '../dump/reservation.js';
import { importInBatches, type BatchSummary } from '../dump/batched-importer.js';
import { mergeEntity, type MergeCandidate } from './merge.js';
import { logger } from '../logger.js';

export interface DumpRunOptions {
  db: BetterSQLite3Database;
  stateName: string;
  url: string;
  dumpPath?: string;
  noDownload?: boolean;
  reset?: boolean;
  keepDump?: boolean;
  batchSize?: number;
  keyOf: (fields: string[]) => string | null;
  parse: (fields: string[]) => MergeCandidate[];
  /** Optional per-record post-merge hook (e.g. hydrate book_contributors). */
  hydrate?: (fields: string[]) => void;
}

export async function runDumpImport(opts: DumpRunOptions): Promise<BatchSummary> {
  const dumpDir = resolve(opts.dumpPath ?? process.env.OL_DUMP_PATH ?? resolve(process.cwd(), 'data', 'dumps'));
  if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });
  const gzPath = resolve(dumpDir, `${opts.stateName}.txt.gz`);
  const lockPath = resolve(dumpDir, `${opts.stateName}.lock`);

  if (!acquireLock(lockPath)) {
    logger.warn({ stateName: opts.stateName }, 'lock held by another run; aborting');
    process.exit(1);
  }

  const state = new DumpState(opts.db, opts.stateName);
  const reservation = new Reservation(opts.db, opts.stateName);
  reservation.acquire();

  try {
    if (opts.reset) state.clear();
    const existing = state.get();

    // Download unless asked to reuse the local file.
    if (!opts.noDownload || !existsSync(gzPath)) {
      const downloader = new HttpDownloader(opts.url);
      const meta = await downloader.downloadWithRetry(gzPath);
      state.set({ url: meta.url, lastModified: meta.lastModified, fileSize: meta.contentLength });
    }

    // Resume is cursor-based: gzip cannot be seeked safely, so we always start
    // at byte 0 and skip records whose key <= the persisted cursor.
    const lastKeyCursor = existing?.cursor ?? null;

    let summary: BatchSummary | null = null;
    const runOnce = async (offset: number, cursor: string | null): Promise<BatchSummary> => {
      const streamer = new DumpStreamer(gzPath);
      const items = streamer.iter({ startByteOffset: offset, lastKeyCursor: cursor, keyOf: opts.keyOf });
      const s = await importInBatches(opts.db, items, {
        batchSize: opts.batchSize ?? 500,
        upsert: (item) => {
          const cands = opts.parse(item.fields);
          for (const c of cands) mergeEntity(opts.db, c);
          opts.hydrate?.(item.fields);
          return { action: 'inserted' };
        },
      });
      return s;
    };

    try {
      summary = await runOnce(0, lastKeyCursor);
    } catch (err) {
      if (err instanceof SeekError) {
        logger.warn({ err: err.message }, 'gz resume failed; replaying from byte 0');
        summary = await runOnce(0, lastKeyCursor);
      } else {
        throw err;
      }
    }

    state.set({ lastKeyCursor: null, lastByteOffset: 0 });
    state.markComplete();

    if (!opts.keepDump) {
      try {
        unlinkSync(gzPath);
        logger.info({ gzPath }, 'removed dump file after import');
      } catch {
        // best-effort cleanup
      }
    }

    logger.info({ ...summary }, 'dump import complete');
    return summary;
  } finally {
    reservation.release();
    releaseLock(lockPath);
  }
}
