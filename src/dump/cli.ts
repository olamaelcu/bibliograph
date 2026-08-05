#!/usr/bin/env node
import { resolve } from 'node:path';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import { DumpState } from './state.js';
import { HttpDownloader } from './downloader.js';
import { DumpStreamer } from './streamer.js';
import { runEditionsDumpImport, prepareRun } from './index.js';

interface ParsedCli {
  noDownload: boolean;
  reset: boolean;
  batchSize?: number;
  dumpPath?: string;
  dryRun: boolean;
  keepDump: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): ParsedCli {
  const parsed: ParsedCli = {
    noDownload: false,
    reset: false,
    dryRun: false,
    keepDump: false,
    force: false,
  };
  for (const arg of argv) {
    if (arg === '--no-download') parsed.noDownload = true;
    else if (arg === '--reset') parsed.reset = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
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

const OL_DUMP_PATH_DEFAULT =
  process.env.OL_DUMP_PATH ?? resolve(process.cwd(), 'data', 'dumps');
const OL_DUMP_URL_DEFAULT =
  process.env.OL_DUMP_URL ?? 'https://openlibrary.org/data/ol_dump_editions_latest.txt.gz';
export function OL_DUMP_BATCH_SIZE_DEFAULT_FOR_TESTS(raw: string | undefined): number {
  if (!raw) return 500;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 500;
}
const OL_DUMP_BATCH_SIZE_DEFAULT = OL_DUMP_BATCH_SIZE_DEFAULT_FOR_TESTS(process.env.OL_DUMP_BATCH_SIZE);
const STATE_NAME = 'openlibrary_editions';

const STALE_LOCK_AGE_MS = 24 * 60 * 60 * 1000;

export function acquireLock(lockPath: string, force: boolean): boolean {
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
    logger.warn({ lockPath }, 'dump lockfile present; another run is in progress');
    return false;
  }
  if (!isStaleLock(lockPath)) {
    logger.warn({ lockPath }, 'dump lockfile held by a live process; --force refused');
    return false;
  }
  try { unlinkSync(lockPath); } catch {}
  return acquireLock(lockPath, false);
}

export function isStaleLock(lockPath: string): boolean {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const [pidStr, isoStr] = raw.split('\n', 2);
    const pid = Number(pidStr);
    const ageMs = Date.now() - new Date(isoStr).getTime();
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    return !alive && ageMs > STALE_LOCK_AGE_MS;
  } catch {
    return false;
  }
}

export function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const dumpDir = resolve(cli.dumpPath ?? OL_DUMP_PATH_DEFAULT);
  const filename = 'ol_dump_editions_latest.txt.gz';
  const gzPath = resolve(dumpDir, filename);

  if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });

  const lockPath = resolve(dumpDir, '.import.lock');
  if (!acquireLock(lockPath, cli.force)) {
    process.exit(0);
  }
  process.on('exit', () => releaseLock(lockPath));

  const state = new DumpState(db, STATE_NAME);

  if (cli.reset) {
    state.clear();
    logger.info({ dumpDir }, 'dump:openlibrary reset checkpoint');
  }

  const downloader = new HttpDownloader(OL_DUMP_URL_DEFAULT, {
    userAgent: process.env.OL_DUMP_USER_AGENT,
  });

  const { lastModified, fileSize } = await prepareRun({
    downloader,
    state,
    gzPath,
    url: OL_DUMP_URL_DEFAULT,
    noDownload: cli.noDownload,
  });

  if (cli.dryRun) {
    let total = 0;
    let withIsbn = 0;
    for await (const item of new DumpStreamer(gzPath).iter({ startByteOffset: 0, lastNumericCursor: null })) {
      total += 1;
      if (item.record.isbn_13?.[0] ?? item.record.isbn_10?.[0]) withIsbn += 1;
    }
    logger.info({ gzPath, total, withIsbn }, 'dry-run parse complete; not importing');
    return;
  }

  const controller = new AbortController();
  let secondSignal = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (secondSignal) {
      logger.warn({ sig }, 'dump:openlibrary second signal received; exiting hard');
      process.exit(130);
    }
    secondSignal = true;
    logger.warn({ sig }, 'dump:openlibrary received signal; aborting after current batch');
    controller.abort();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const summary = await runEditionsDumpImport({
    db,
    state,
    downloader,
    gzPath,
    stateName: STATE_NAME,
    url: OL_DUMP_URL_DEFAULT,
    lastModified,
    fileSize,
    batchSize: cli.batchSize ?? OL_DUMP_BATCH_SIZE_DEFAULT,
    signal: controller.signal,
  });

  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);

  if (controller.signal.aborted) {
    logger.warn({ summary }, 'dump:openlibrary aborted; state preserved, safe to resume');
  } else {
    logger.info({ summary }, 'dump:openlibrary finished');
    if (!cli.keepDump) {
      try { rmSync(gzPath, { force: true }); } catch {}
      try { rmSync(`${gzPath}.part`, { force: true }); } catch {}
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'dump:openlibrary failed');
  process.exit(1);
});
