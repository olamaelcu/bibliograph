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
    throw new Error(`lock held for state '${opts.stateName}'; another import is running`);
  }

  const state = new DumpState(opts.db, opts.stateName);
  const reservation = new Reservation(opts.db, opts.stateName);
  if (!reservation.acquire()) {
    // Either another live run holds the reservation, or the DB is mid-write
    // (SQLITE_BUSY). Distinguish so the operator knows what actually happened.
    if (reservation.isHeld()) {
      logger.warn({ stateName: opts.stateName }, 'reservation held by another run; aborting');
      throw new Error(`reservation held for state '${opts.stateName}'`);
    }
    logger.warn({ stateName: opts.stateName }, 'database busy; another import appears to be writing');
    throw new Error(`database busy; is another import running for state '${opts.stateName}'?`);
  }
  let acquired = true;

  try {
    if (opts.reset) state.clear();
    const existing = state.get();

    // Download unless asked to reuse the local file.
    if (!opts.noDownload || !existsSync(gzPath)) {
      logger.info({ stateName: opts.stateName, url: opts.url, gzPath }, 'downloading dump');
      const downloader = new HttpDownloader(opts.url);
      const meta = await downloader.downloadWithRetry(gzPath);
      state.set({ url: meta.url, lastModified: meta.lastModified, fileSize: meta.contentLength });
    } else {
      logger.info({ stateName: opts.stateName, gzPath }, 'reusing existing dump file');
    }

    // Resume is cursor-based: gzip cannot be seeked safely, so we always start
    // at byte 0 and skip records whose key <= the persisted cursor.
    const lastKeyCursor = existing?.cursor ?? null;

    // NOTE: byte-seek resume is intentionally unused. `runOnce` is always called
    // with offset 0, so `SeekError` below is unreachable in practice; the branch
    // is kept only as a defensive replay path if a future caller ever passes a
    // non-zero offset.
    const runOnce = async (offset: number, cursor: string | null): Promise<BatchSummary> => {
      const streamer = new DumpStreamer(gzPath);
      const items = streamer.iter({ startByteOffset: offset, lastKeyCursor: cursor, keyOf: opts.keyOf });
      const s = await importInBatches(opts.db, items, {
        batchSize: opts.batchSize ?? 500,
        upsert: (item) => {
          const cands = opts.parse(item.fields);
          let inserted = false;
          for (const c of cands) {
            const res = mergeEntity(opts.db, c);
            if (!res.existed) inserted = true;
          }
          opts.hydrate?.(item.fields);
          return { action: inserted ? 'inserted' : 'skipped' };
        },
      });
      return s;
    };

    let summary: BatchSummary | null = null;
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
    if (acquired) reservation.release();
    releaseLock(lockPath);
  }
}
