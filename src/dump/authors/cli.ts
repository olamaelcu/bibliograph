#!/usr/bin/env node
import { resolve } from 'node:path';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { db } from '../../db/connection.js';
import { logger } from '../../logger.js';
import { DumpState } from '../state.js';
import { HttpDownloader } from '../downloader.js';
import { runAuthorsDumpImport } from './batched-importer.js';

export interface AuthorsCliOptions {
  noDownload?: boolean;
  reset?: boolean;
  batchSize?: number;
  dumpPath?: string;
  force?: boolean;
  keepDump?: boolean;
  signal?: AbortSignal;
}

const STATE_NAME = 'authors';
const OL_DUMP_PATH_DEFAULT =
  process.env.OL_DUMP_PATH ?? resolve(process.cwd(), 'data', 'dumps');
const OL_AUTHORS_DUMP_URL_DEFAULT =
  process.env.OL_AUTHORS_DUMP_URL ?? 'https://openlibrary.org/data/ol_dump_authors_latest.txt.gz';

export function parseAuthorsArgs(argv: string[]): AuthorsCliOptions {
  const parsed: AuthorsCliOptions = {};
  for (const arg of argv) {
    if (arg === '--no-download') parsed.noDownload = true;
    else if (arg === '--reset') parsed.reset = true;
    else if (arg === '--keep-dump') parsed.keepDump = true;
    else if (arg === '--force') parsed.force = true;
    else if (arg.startsWith('--path=')) parsed.dumpPath = arg.slice('--path='.length);
    else if (arg.startsWith('--batch-size=')) {
      const n = Number(arg.slice('--batch-size='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid batch-size: ${arg}`);
      parsed.batchSize = n;
    }
  }
  return parsed;
}

export function acquireAuthorsLock(lockPath: string, force: boolean): boolean {
  if (!existsSync(lockPath)) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    try {
      writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  }
  if (!force) {
    logger.warn({ lockPath }, 'authors dump lockfile present; another run is in progress');
    return false;
  }
  try { unlinkSync(lockPath); } catch {}
  return acquireAuthorsLock(lockPath, false);
}

export function releaseAuthorsLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

export async function runAuthorsCli(opts: AuthorsCliOptions = {}): Promise<void> {
  const cli: AuthorsCliOptions = { ...opts };

  const dumpDir = resolve(cli.dumpPath ?? OL_DUMP_PATH_DEFAULT);
  const filename = 'ol_dump_authors_latest.txt.gz';
  const gzPath = resolve(dumpDir, filename);

  if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });

  const lockPath = resolve(dumpDir, '.import-authors.lock');
  if (!acquireAuthorsLock(lockPath, cli.force ?? false)) {
    process.exit(0);
  }
  process.on('exit', () => releaseAuthorsLock(lockPath));

  const state = new DumpState(db, STATE_NAME);

  if (cli.reset) {
    state.clear();
    logger.info({ dumpDir }, 'dump:authors reset checkpoint');
  }

  const downloader = new HttpDownloader(OL_AUTHORS_DUMP_URL_DEFAULT, {
    userAgent: process.env.OL_DUMP_USER_AGENT,
  });

  if (!cli.noDownload && !existsSync(gzPath)) {
    await downloader.downloadWithRetry(gzPath);
    state.set({
      url: OL_AUTHORS_DUMP_URL_DEFAULT,
      filePath: gzPath,
      lastModified: null,
      fileSize: existsSync(gzPath) ? readFileSync(gzPath).byteLength : null,
      lastByteOffset: 0,
      lastKeyCursor: null,
      lastNumericCursor: null,
      startedAt: state.get()?.startedAt ?? new Date().toISOString(),
      totalProcessed: 0,
      complete: false,
    });
  }

  const controller = new AbortController();
  let secondSignal = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (secondSignal) {
      logger.warn({ sig }, 'dump:authors second signal received; exiting hard');
      process.exit(130);
    }
    secondSignal = true;
    logger.warn({ sig }, 'dump:authors received signal; aborting after current batch');
    controller.abort();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const summary = await runAuthorsDumpImport({
    db,
    state,
    downloader,
    gzPath,
    stateName: STATE_NAME,
    url: OL_AUTHORS_DUMP_URL_DEFAULT,
    batchSize: cli.batchSize,
    signal: controller.signal,
  });

  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);

  if (controller.signal.aborted) {
    logger.warn({ summary }, 'dump:authors aborted; state preserved, safe to resume');
  } else {
    logger.info({ summary }, 'dump:authors finished');
    if (!cli.keepDump) {
      try { rmSync(gzPath, { force: true }); } catch {}
      try { rmSync(`${gzPath}.part`, { force: true }); } catch {}
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAuthorsCli().catch((err) => {
    logger.fatal({ err }, 'dump:authors failed');
    process.exit(1);
  });
}
