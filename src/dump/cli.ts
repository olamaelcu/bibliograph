#!/usr/bin/env node
import { resolve } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import { DumpState } from './state.js';
import { HttpDownloader } from './downloader.js';
import { runEditionsDumpImport } from './index.js';

interface ParsedCli {
  noDownload: boolean;
  reset: boolean;
  batchSize?: number;
  dumpPath?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedCli {
  const parsed: ParsedCli = { noDownload: false, reset: false, dryRun: false };
  for (const arg of argv) {
    if (arg === '--no-download') parsed.noDownload = true;
    else if (arg === '--reset') parsed.reset = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
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
const OL_DUMP_BATCH_SIZE_DEFAULT = Number(process.env.OL_DUMP_BATCH_SIZE ?? '500');
const STATE_NAME = 'openlibrary_editions';

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const dumpDir = resolve(cli.dumpPath ?? OL_DUMP_PATH_DEFAULT);
  const filename = 'ol_dump_editions_latest.txt.gz';
  const gzPath = resolve(dumpDir, filename);

  if (!existsSync(dumpDir)) mkdirSync(dumpDir, { recursive: true });

  const state = new DumpState(db, STATE_NAME);

  if (cli.reset) {
    state.clear();
    logger.info({ dumpDir }, 'dump:openlibrary reset checkpoint');
  }

  const downloader = new HttpDownloader(OL_DUMP_URL_DEFAULT, {
    userAgent: process.env.OL_DUMP_USER_AGENT,
  });

  if (!cli.noDownload) {
    logger.info({ url: OL_DUMP_URL_DEFAULT, dest: gzPath }, 'dump:openlibrary downloading');
    const meta = await downloader.headMetadata();
    const matchesPrior = state.get()?.lastModified === meta.lastModified;
    const priorOffset = state.get()?.lastByteOffset ?? 0;
    const priorSize = state.get()?.fileSize ?? 0;
    const fileSizeOnDisk = existsSync(gzPath) ? statSync(gzPath).size : 0;
    const isUpToDate = fileSizeOnDisk > 0 &&
      fileSizeOnDisk === priorSize &&
      matchesPrior &&
      priorOffset >= priorSize;

    if (!isUpToDate) {
      await downloader.downloadWithRetry(gzPath);
      state.set({
        url: OL_DUMP_URL_DEFAULT,
        filePath: gzPath,
        lastModified: meta.lastModified,
        fileSize: statSync(gzPath).size,
        lastByteOffset: 0,
        lastKeyCursor: null,
        startedAt: new Date().toISOString(),
        totalProcessed: 0,
        complete: false,
      });
    } else {
      logger.info({ gzPath, offset: priorOffset }, 'dump:openlibrary local file up to date; resuming');
    }
  }

  if (cli.dryRun) {
    logger.info({ gzPath }, 'dump:openlibrary dry-run; not importing');
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

  const existing = state.get();
  const summary = await runEditionsDumpImport({
    db,
    state,
    downloader,
    gzPath,
    stateName: STATE_NAME,
    url: OL_DUMP_URL_DEFAULT,
    lastModified: existing?.lastModified ?? null,
    fileSize: existing?.fileSize ?? null,
    batchSize: cli.batchSize ?? OL_DUMP_BATCH_SIZE_DEFAULT,
    signal: controller.signal,
  });

  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);

  if (controller.signal.aborted) {
    logger.warn({ summary }, 'dump:openlibrary aborted; state preserved, safe to resume');
  } else {
    logger.info({ summary }, 'dump:openlibrary finished');
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'dump:openlibrary failed');
  process.exit(1);
});
