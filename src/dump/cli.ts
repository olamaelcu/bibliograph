#!/usr/bin/env node
import { resolve } from 'node:path';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import { DumpState } from './state.js';
import { HttpDownloader } from './downloader.js';
import { DumpStreamer } from './streamer.js';
import { runEditionsDumpImport, prepareRun } from './index.js';
import { runAuthorsCli } from './authors/cli.js';

interface ParsedCli {
  command: 'editions' | 'authors';
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
    command: 'editions',
    noDownload: false,
    reset: false,
    dryRun: false,
    keepDump: false,
    force: false,
  };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === 'editions') parsed.command = 'editions';
    else if (arg === 'authors') parsed.command = 'authors';
    else if (arg === '--no-download') parsed.noDownload = true;
    else if (arg === '--reset') parsed.reset = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--keep-dump') parsed.keepDump = true;
    else if (arg === '--force') parsed.force = true;
    else if (arg.startsWith('--path=')) parsed.dumpPath = arg.slice('--path='.length);
    else if (arg.startsWith('--batch-size=')) {
      const n = Number(arg.slice('--batch-size='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid batch-size: ${arg}`);
      parsed.batchSize = n;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0 && (positional[0] === 'editions' || positional[0] === 'authors')) {
    parsed.command = positional[0];
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

export function clearStaleLockIfNeeded(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  let pidStr: string | undefined;
  let pid: number;
  try {
    const raw = readFileSync(lockPath, 'utf8');
    pidStr = raw.split('\n', 1)[0];
    pid = Number(pidStr);
  } catch (err) {
    logger.warn({ lockPath, err }, 'lockfile unreadable; leaving alone');
    return false;
  }
  if (!Number.isFinite(pid)) {
    logger.warn({ lockPath, pidStr }, 'lockfile has invalid pid; leaving alone');
    return false;
  }
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) {
    logger.warn({ lockPath, pid }, 'lockfile held by a live process; cannot auto-clear');
    return false;
  }
  logger.info({ lockPath, pid }, 'clearing stale lockfile on startup (PID no longer alive)');
  try { unlinkSync(lockPath); } catch (err) {
    logger.warn({ lockPath, err }, 'failed to unlink stale lockfile');
    return false;
  }
  return true;
}

export function isStaleLock(lockPath: string): boolean {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const [pidStr] = raw.split('\n', 2);
    const pid = Number(pidStr);
    if (!Number.isFinite(pid)) return false;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    return !alive;
  } catch {
    return false;
  }
}

export function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

export async function runEditionsCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseArgs([...argv]);
  const dumpDir = resolve(cli.dumpPath ?? OL_DUMP_PATH_DEFAULT);
  const filename = 'ol_dump_editions_latest.txt.gz';
  const gzPath = resolve(dumpDir, filename);

  if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });

  const lockPath = resolve(dumpDir, '.import.lock');
  clearStaleLockIfNeeded(lockPath);
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === 'authors') {
    await runAuthorsCli(parseAuthorsArgsRest(argv.slice(1)));
    return;
  }
  await runEditionsCli(argv);
}

function parseAuthorsArgsRest(rest: string[]): {
  noDownload: boolean;
  reset: boolean;
  batchSize?: number;
  dumpPath?: string;
  force: boolean;
  keepDump: boolean;
} {
  const parsed = {
    noDownload: false,
    reset: false,
    force: false,
    keepDump: false,
  } as {
    noDownload: boolean;
    reset: boolean;
    batchSize?: number;
    dumpPath?: string;
    force: boolean;
    keepDump: boolean;
  };
  for (const arg of rest) {
    if (arg === '--no-download') parsed.noDownload = true;
    else if (arg === '--reset') parsed.reset = true;
    else if (arg === '--force') parsed.force = true;
    else if (arg === '--keep-dump') parsed.keepDump = true;
    else if (arg.startsWith('--path=')) parsed.dumpPath = arg.slice('--path='.length);
    else if (arg.startsWith('--batch-size=')) {
      const n = Number(arg.slice('--batch-size='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid batch-size: ${arg}`);
      parsed.batchSize = n;
    }
  }
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.fatal({ err }, 'dump cli failed');
    process.exit(1);
  });
}
