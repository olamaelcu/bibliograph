#!/usr/bin/env node
import { db } from './db/connection.js';
import { logger } from './logger.js';
import { populateAllHashes, analyzeDuplicates, getStats } from './dedup-detection.js';
import { mergeDuplicates } from './dedup-merge.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'stats':
      await showStats();
      break;
    case 'analyze':
      await runAnalyze(args);
      break;
    case 'populate-hashes':
      await runPopulateHashes();
      break;
    case 'merge':
      await runMerge(args);
      break;
    case 'run':
      await runFullDedup(args);
      break;
    case 'watch':
      await runWatch(args);
      break;
    default:
      console.error(`Usage: dedup <command>

Commands:
  stats            Show deduplication statistics
  analyze [limit]  List duplicate groups (default: 50)
  populate-hashes  Compute and store deduplication hashes for all books
  merge [--dry-run]  Merge duplicate books (keep newest, merge identifiers)
  run [--dry-run]  Run full pipeline: populate hashes + merge
  watch [interval] Monitor and auto-dedup at interval (seconds, default: 3600)
`);
      process.exit(1);
  }
}

async function showStats(): Promise<void> {
  const stats = await getStats(db);
  logger.info(stats, 'deduplication statistics');
  console.log(JSON.stringify(stats, null, 2));
}

async function runAnalyze(args: string[]): Promise<void> {
  const limit = args[0] ? parseInt(args[0], 10) : 50;
  const analysis = await analyzeDuplicates(db, limit);
  logger.info(
    {
      totalBooks: analysis.totalBooks,
      uniqueHashes: analysis.uniqueHashes,
      duplicateGroups: analysis.duplicateGroups,
      totalDuplicateRecords: analysis.totalDuplicateRecords,
    },
    'duplicate analysis',
  );

  for (const group of analysis.groups) {
    console.log(`\n${group.title} by ${group.author} (${group.books.length} duplicates, hash: ${group.hash})`);
    for (const book of group.books) {
      const olIds = book.identifiers
        .filter((id) => id.type === 'openlibrary')
        .map((id) => id.value)
        .join(', ');
      console.log(`  ${book.uri}  ${book.createdAt}  OL: ${olIds || 'none'}`);
    }
  }
}

async function runPopulateHashes(): Promise<void> {
  const result = await populateAllHashes(db);
  console.log(JSON.stringify(result, null, 2));
}

async function runMerge(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  if (dryRun) logger.info('DRY RUN - no changes will be made');

  const result = await mergeDuplicates(db, dryRun);

  logger.info(
    {
      merged: result.merged,
      skipped: result.skipped,
      deleted: result.deleted,
      errors: result.errors,
    },
    'merge complete',
  );

  for (const detail of result.details) {
    console.log(`\nKept: ${detail.kept} (${detail.title} by ${detail.author})`);
    console.log(`  Removed: ${detail.removed.join(', ')}`);
    console.log(`  Identifiers merged: ${detail.identifiersMerged}`);
    if (detail.error) console.log(`  Error: ${detail.error}`);
  }
}

async function runFullDedup(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  if (dryRun) logger.info('DRY RUN - no changes will be made');

  logger.info('step 1: populating deduplication hashes');
  const hashResult = await populateAllHashes(db);
  logger.info(hashResult, 'hashes populated');

  logger.info('step 2: analyzing duplicates');
  const analysis = await analyzeDuplicates(db, 1000);
  logger.info(
    {
      duplicateGroups: analysis.duplicateGroups,
      totalDuplicateRecords: analysis.totalDuplicateRecords,
    },
    'analysis complete',
  );

  if (analysis.duplicateGroups === 0) {
    logger.info('no duplicates found, skipping merge');
    process.exit(0);
  }

  logger.info('step 3: merging duplicates');
  await runMerge(dryRun ? ['--dry-run'] : []);
}

function parseInterval(raw?: string): number {
  if (!raw) return 3600;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 60) return 3600;
  return n;
}

async function runWatch(args: string[]): Promise<void> {
  const intervalSec = parseInterval(args[0]);
  logger.info({ intervalSec }, 'starting dedup watch mode');

  const tick = async () => {
    try {
      logger.info('dedup watch: running cycle');
      await runFullDedup([]);
      logger.info('dedup watch: cycle complete');
    } catch (err) {
      logger.error({ err }, 'dedup watch: cycle failed');
    }
  };

  await tick();
  setInterval(tick, intervalSec * 1000);

  process.on('SIGINT', () => {
    logger.info('dedup watch: shutting down');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('dedup watch: shutting down');
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.fatal({ err }, 'dedup job failed');
    process.exit(1);
  });
}
