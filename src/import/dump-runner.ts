import { resolve } from 'node:path';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { DumpState } from '../dump/state.js';
import { DumpStreamer, SeekError } from '../dump/streamer.js';
import { HttpDownloader } from '../dump/downloader.js';
import { acquireLock, releaseLock } from '../dump/lock.js';
import { Reservation } from '../dump/reservation.js';
import { countDumpLines, readCountCache, writeCountCache } from '../dump/count-lines.js';
import { splitTsv } from '../dump/tsv.js';
import { buildSnapshot, snapshotIsCurrent, snapshotPathOf } from '../dump/snapshot.js';
import { importInBatches, type BatchSummary } from '../dump/batched-importer.js';
import { mergeEntity, type MergeCandidate } from './merge.js';
import { buildMergeBatchContext, mergeBatch } from './merge-batch.js';
import { logger } from '../logger.js';
import { InterruptedError, abortReason } from '../dump/interrupt.js';

type Database = NodePgDatabase<typeof schema>;

export interface DumpRunOptions {
  db: Database;
  stateName: string;
  url: string;
  dumpPath?: string;
  noDownload?: boolean;
  reset?: boolean;
  keepDump?: boolean;
  /** Keep an uncompressed sidecar so a resume can byte-seek instead of replaying from 0. */
  useSnapshot?: boolean;
  batchSize?: number;
  /** Called as download body bytes stream in: (received, total|null). */
  onProgress?: (received: number, total: number | null) => void;
  /** Called as import records are processed: (processedIncludingResume, total|null). */
  onImportProgress?: (processed: number, total: number | null) => void;
  /** Key extraction for resume-skip ordering (sortable key or null). */
  keyOf: (line: string) => string | null;
  parse: (fields: string[]) => MergeCandidate[] | Promise<MergeCandidate[]>;
  /**
   * Fast-path: when true the record is counted as skipped and parse/merge are
   * not run (the line is not even split). Lets redundant passes (e.g. the
   * authors dump after editions) skip records that already exist.
   */
  skipIfSeen?: (key: string | null, line: string) => boolean | Promise<boolean>;
  /** Called after each batch transaction commits (outside the transaction). */
  afterBatch?: () => void | Promise<void>;
  /** Abort: stop the import cleanly at the next safe point and mark the run stopped. */
  signal?: AbortSignal;
  /** Skip the per-record name fallback during OL backfills (521ms seq scan on 278k rows). */
  skipNameFallback?: boolean;
  /**
   * Use the batched merge path (`mergeBatch` from `merge-batch.ts`) instead
   * of the per-record `mergeEntity`. B2a optimization: hoists identifier and
   * entity row lookups to per-batch scope. The per-record path is the
   * default and the source of truth; the batched path is opt-in.
   */
  batchedMerge?: boolean;
}

export async function runDumpImport(opts: DumpRunOptions): Promise<BatchSummary> {
  const dumpDir = resolve(opts.dumpPath ?? process.env.OL_DUMP_PATH ?? resolve(process.cwd(), 'data', 'dumps'));
  if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });
  const gzPath = resolve(dumpDir, `${opts.stateName}.txt.gz`);
  const snapshotPath = snapshotPathOf(gzPath);
  const lockPath = resolve(dumpDir, `${opts.stateName}.lock`);

  if (!acquireLock(lockPath)) {
    logger.warn({ stateName: opts.stateName }, 'lock held by another run; aborting');
    throw new Error(`lock held for state '${opts.stateName}'; another import is running`);
  }

  const state = new DumpState(opts.db, opts.stateName);
  const reservation = new Reservation(opts.db, opts.stateName);
  if (!(await reservation.acquire())) {
    // Either another live run holds the reservation, or the DB is mid-write
    // (SQLITE_BUSY). Distinguish so the operator knows what actually happened.
    if (await reservation.isHeld()) {
      logger.warn({ stateName: opts.stateName }, 'reservation held by another run; aborting');
      throw new Error(`reservation held for state '${opts.stateName}'`);
    }
    logger.warn({ stateName: opts.stateName }, 'database busy; another import appears to be writing');
    throw new Error(`database busy; is another import running for state '${opts.stateName}'?`);
  }
  let acquired = true;

  try {
    if (opts.reset) await state.clear();
    const existing = await state.get();

    // Download unless asked to reuse the local file. The downloader resumes a
    // partial file on disk via HTTP Range (206) instead of restarting.
    if (!opts.noDownload || !existsSync(gzPath)) {
      if (!opts.noDownload && existsSync(gzPath)) {
        logger.info({ stateName: opts.stateName, gzPath }, 'resuming existing dump file');
      } else {
        logger.info({ stateName: opts.stateName, url: opts.url, gzPath }, 'downloading dump');
      }
      const downloader = new HttpDownloader(opts.url, { onProgress: opts.onProgress, signal: opts.signal });
      const meta = await downloader.downloadWithRetry(gzPath);
      await state.set({ url: meta.url, lastModified: meta.lastModified, fileSize: meta.contentLength });
    } else {
      logger.info({ stateName: opts.stateName, gzPath }, 'reusing existing dump file');
    }

    if (opts.signal?.aborted) throw abortReason(opts.signal) ?? new InterruptedError('SIGINT');

    // Uncompressed snapshot: decompress once so interrupted runs can byte-seek
    // back to the checkpoint instead of replaying from byte 0.
    const useSnapshot = Boolean(opts.useSnapshot);
    if (useSnapshot && !snapshotIsCurrent(gzPath, snapshotPath)) {
      await buildSnapshot(gzPath, snapshotPath, opts.signal);
    }

    const lastKeyCursor = existing?.cursor ?? null;
    const lastByteOffset = existing?.lastByteOffset ?? 0;
    // Continue the progress bar from where the previous run left off instead of
    // restarting at 0 (records already processed are skipped, not replayed).
    const progressBase = existing?.totalProcessed ?? 0;

    // Resolve the total record count for progress: reuse the sidecar cache when
    // the file is unchanged, otherwise one pass to count lines exactly. A plain
    // snapshot counts without gunzipping.
    let total = readCountCache(gzPath);
    if (total === null) {
      logger.info({ stateName: opts.stateName, gzPath }, 'counting dump records');
      total = await countDumpLines(useSnapshot ? snapshotPath : gzPath, { plain: useSnapshot, signal: opts.signal });
      writeCountCache(gzPath, total);
    }
    logger.info({ stateName: opts.stateName, totalRecords: total }, 'dump record count');
    await state.set({ totalRecords: total });

    // Resuming replays from byte 0 and cursor-skips for a gzip source; a
    // snapshot source seeks straight to the checkpointed byte offset.
    const runOnce = async (offset: number, cursor: string | null): Promise<BatchSummary> => {
      const streamer = new DumpStreamer(useSnapshot ? snapshotPath : gzPath, useSnapshot);
      const items = streamer.iter({ startByteOffset: offset, lastKeyCursor: cursor, keyOf: opts.keyOf, signal: opts.signal });
      let lastKey: string | null = null;
      let lastEndOffset = offset;
      const s = await importInBatches(opts.db, items, {
        batchSize: opts.batchSize ?? 2000,
        total,
        afterBatch: opts.afterBatch,
        signal: opts.signal,
        onProgress: opts.onImportProgress
          ? (processed, t) => opts.onImportProgress?.(progressBase + processed, t)
          : undefined,
        onCheckpoint: (processed) => state.set({
          lastKeyCursor: lastKey,
          lastByteOffset: lastEndOffset,
          totalProcessed: progressBase + processed,
        }),
        upsertBatch: opts.batchedMerge
          ? async (tx, batch) => {
              const actions: Array<{ action: 'inserted' | 'skipped' | 'failed' }> = [];
              const allCands: MergeCandidate[] = [];
              const candCounts: number[] = []; // per record: how many candidates it produced
              for (const item of batch) {
                if (item.key !== null) lastKey = item.key;
                lastEndOffset = item.byteOffset + Buffer.byteLength(item.line, 'utf8') + 1;
                if (await opts.skipIfSeen?.(item.key, item.line)) {
                  actions.push({ action: 'skipped' });
                  candCounts.push(0);
                  continue;
                }
                const fields = splitTsv(item.line, 5);
                try {
                  const cands = await opts.parse(fields);
                  candCounts.push(cands.length);
                  allCands.push(...cands);
                  actions.push({ action: 'inserted' }); // tentative
                } catch (err) {
                  logger.warn({ err }, 'parse failed for batched record');
                  candCounts.push(0);
                  actions.push({ action: 'failed' });
                }
              }
              if (allCands.length === 0) return actions;
              const ctx = await buildMergeBatchContext(tx, allCands);
              const results = await mergeBatch(tx, allCands, ctx, { skipNameFallback: opts.skipNameFallback });
              // Walk actions and consume results in order. A record is
              // "inserted" if any of its candidates was a fresh insert;
              // otherwise "skipped" (existed or all duplicates). A record
              // whose parse produced 0 candidates keeps its tentative
              // 'inserted' but we re-evaluate to 'skipped' since there
              // was nothing to do.
              let candIdx = 0;
              for (let i = 0; i < batch.length; i++) {
                if (actions[i].action === 'failed' || actions[i].action === 'skipped') continue;
                const n = candCounts[i];
                if (n === 0) {
                  actions[i] = { action: 'skipped' };
                  continue;
                }
                let anyNew = false;
                for (let j = 0; j < n; j++) {
                  if (results[candIdx + j] && !results[candIdx + j].existed) {
                    anyNew = true;
                    break;
                  }
                }
                actions[i] = { action: anyNew ? 'inserted' : 'skipped' };
                candIdx += n;
              }
              return actions;
            }
          : undefined,
        upsert: opts.batchedMerge
          ? (async () => { throw new Error('upsert must not be called when batchedMerge is set'); }) as never
          : async (tx, item) => {
              if (item.key !== null) lastKey = item.key;
              lastEndOffset = item.byteOffset + Buffer.byteLength(item.line, 'utf8') + 1;
              if (await opts.skipIfSeen?.(item.key, item.line)) return { action: 'skipped' as const };
              const fields = splitTsv(item.line, 5);
              const cands = await opts.parse(fields);
              let inserted = false;
              for (const c of cands) {
                const res = await mergeEntity(tx, c, { skipNameFallback: opts.skipNameFallback });
                if (!res.existed) inserted = true;
              }
              return { action: inserted ? ('inserted' as const) : ('skipped' as const) };
            },
      });
      return s;
    };

    let summary: BatchSummary | null = null;
    const resumeOffset = useSnapshot ? lastByteOffset : 0;
    try {
      summary = await runOnce(resumeOffset, lastKeyCursor);
    } catch (err) {
      if (err instanceof SeekError) {
        logger.warn({ err: err.message }, 'gz resume failed; replaying from byte 0');
        summary = await runOnce(0, lastKeyCursor);
      } else {
        // An interrupted/aborted run: keep the resume checkpoint and mark the
        // state as stopped so a later run resumes from where it stopped. The
        // processed count comes from the checkpoint that was committed just
        // before the stop (importInBatches flushed + checkpointed the batch
        // it was in the middle of).
        if (opts.signal?.aborted || err instanceof InterruptedError) {
          await state.set({ stopped: true });
          const stoppedState = await state.get();
          logger.info({ stateName: opts.stateName }, 'import stopped; resume checkpoint kept');
          return {
            processed: (stoppedState?.totalProcessed ?? 0) - progressBase,
            inserted: 0,
            skipped: 0,
            failed: 0,
          };
        }
        throw err;
      }
    }

    await state.set({ lastKeyCursor: null, lastByteOffset: 0, totalProcessed: progressBase + (summary?.processed ?? 0) });
    await state.markComplete();

    if (!opts.keepDump) {
      for (const p of [gzPath, snapshotPath, `${snapshotPath}.meta`]) {
        try {
          unlinkSync(p);
        } catch {
          // best-effort cleanup
        }
      }
      logger.info({ stateName: opts.stateName }, 'removed dump files after import');
    }

    logger.info({ ...summary }, 'dump import complete');
    return summary;
  } finally {
    if (acquired) await reservation.release();
    releaseLock(lockPath);
  }
}
