#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  closeSync,
  openSync,
  readFileSync,
  writeSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import { BookhiveCatalogState } from './state.js';
import { createBookhiveResolver } from './resolver.js';
import { runCatalogImport } from './index.js';

const STATE_NAME = 'bookhive_catalog';

const STATE_PATH_DEFAULT = resolve(process.env.BOOKHIVE_STATE_PATH ?? 'data/bookhive');

interface ParsedCli {
  command: 'catalog' | 'activity' | 'users';
  reset: boolean;
  batchSize?: number;
  pageSize?: number;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedCli {
  const nonFlags = argv.filter((a) => !a.startsWith('--'));
  const command = (nonFlags[0] as ParsedCli['command']) ?? 'catalog';
  if (command !== 'catalog' && command !== 'activity' && command !== 'users') {
    throw new Error(`unknown bookhive command: ${command} (expected catalog | activity | users)`);
  }
  const parsed: ParsedCli = { command, reset: false, force: false, dryRun: false };
  for (const arg of argv) {
    if (arg === '--reset') parsed.reset = true;
    else if (arg === '--force') parsed.force = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg.startsWith('--batch-size=')) {
      const n = Number(arg.slice('--batch-size='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid batch-size: ${arg}`);
      parsed.batchSize = n;
    } else if (arg.startsWith('--page-size=')) {
      const n = Number(arg.slice('--page-size='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid page-size: ${arg}`);
      parsed.pageSize = n;
    }
  }
  return parsed;
}

function acquireLock(lockPath: string, force: boolean): boolean {
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
    logger.warn({ lockPath }, 'lockfile present; another run is in progress');
    return false;
  }
  try {
    unlinkSync(lockPath);
  } catch {}
  return acquireLock(lockPath, false);
}

function clearStaleLockIfNeeded(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  let pid = NaN;
  try {
    const raw = readFileSync(lockPath, 'utf8');
    pid = Number(raw.split('\n', 1)[0]);
  } catch {
    return;
  }
  if (!Number.isFinite(pid)) return;
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {}
  if (alive) return;
  logger.info({ lockPath, pid }, 'clearing stale lockfile on startup');
  try {
    unlinkSync(lockPath);
  } catch {}
}

async function runCatalog(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const state = new BookhiveCatalogState(db, STATE_NAME);
  if (cli.reset) {
    state.clear();
    state.set({ catalogDid: '', totalProcessed: 0 });
    logger.info('bookhive:catalog reset checkpoint');
  }

  const { bootstrapContributorTypes } = await import('../db/init.js');
  await bootstrapContributorTypes();

  const resolver = createBookhiveResolver();
  const controller = new AbortController();
  let secondSignal = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (secondSignal) {
      logger.warn({ sig }, 'bookhive:catalog second signal received; exiting hard');
      process.exit(130);
    }
    secondSignal = true;
    logger.warn({ sig }, 'bookhive:catalog received signal; aborting after current batch');
    controller.abort();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const { catalogDid, pdsUrl } = await resolver.resolveCatalog();
  logger.info({ catalogDid, pdsUrl }, 'bookhive:catalog resolved catalog');

  const summary = await runCatalogImport(db, {
    state,
    catalogDid,
    pdsUrl,
    pageSize: cli.pageSize,
    batchSize: cli.batchSize,
    signal: controller.signal,
  });

  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);

  if (controller.signal.aborted) {
    logger.warn({ summary }, 'bookhive:catalog aborted; checkpoint preserved');
  } else {
    logger.info({ summary }, 'bookhive:catalog finished');
  }
}

async function runActivity(): Promise<void> {
  const { BookhiveActivityEnumerator } = await import('./activity.js');
  const resolver = createBookhiveResolver();
  const { catalogDid } = await resolver.resolveCatalog();
  const enumerator = new BookhiveActivityEnumerator(db, { catalogDid });
  const result = await enumerator.enumerate();
  logger.info({ result }, 'bookhive:activity finished');
}

async function runUsers(): Promise<void> {
  const { runUserBackfill } = await import('./index.js');
  const resolver = createBookhiveResolver();
  const summary = await runUserBackfill(db, {
    pdsUrlForDid: (did) => resolver.resolvePds(did),
    pageSize: parseArgs(process.argv.slice(2)).pageSize,
  });
  logger.info({ summary }, 'bookhive:users finished');
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (!existsSync(STATE_PATH_DEFAULT)) mkdirSync(STATE_PATH_DEFAULT, { recursive: true });
  const lockPath = resolve(STATE_PATH_DEFAULT, '.import.lock');
  clearStaleLockIfNeeded(lockPath);
  if (!acquireLock(lockPath, cli.force)) {
    process.exit(0);
  }
  process.on('exit', () => {
    try { unlinkSync(lockPath); } catch {}
  });

  switch (cli.command) {
    case 'catalog':
      await runCatalog();
      break;
    case 'activity':
      await runActivity();
      break;
    case 'users':
      await runUsers();
      break;
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'bookhive:catalog failed');
  process.exit(1);
});

// Silence unused-import warning if rmSync never gets called (kept for symmetry with dump/cli)
void rmSync;
