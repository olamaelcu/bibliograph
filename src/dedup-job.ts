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
    default:
      console.error(`Usage: dedup <command>

Commands:
  stats              Show deduplication statistics
  analyze [limit]    List duplicate groups (default: 50)
  populate-hashes    Compute and store deduplication hashes for all books
  merge [--dry-run]  Merge duplicate books (keep newest, merge identifiers)
  run [--dry-run]    Run full pipeline: populate hashes + merge
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

export async function runFullDedup(args: string[]): Promise<void> {
  const startTime = Date.now();
  const dryRun = args.includes('--dry-run');
  logger.info({ dryRun, startedAt: new Date().toISOString() }, 'dedup run: starting');

  logger.info('dedup run: step 1/3 — populating deduplication hashes');
  const t1 = Date.now();
  const hashResult = await populateAllHashes(db);
  logger.info(
    { ...hashResult, durationMs: Date.now() - t1 },
    'dedup run: step 1/3 complete — hashes populated',
  );

  logger.info('dedup run: step 2/3 — analyzing duplicates');
  const t2 = Date.now();
  const analysis = await analyzeDuplicates(db, 1000);
  logger.info(
    {
      totalBooks: analysis.totalBooks,
      duplicateGroups: analysis.duplicateGroups,
      totalDuplicateRecords: analysis.totalDuplicateRecords,
      durationMs: Date.now() - t2,
    },
    'dedup run: step 2/3 complete — duplicate analysis (aggregate)',
  );

  if (analysis.duplicateGroups > 0) {
    logger.info(
      { groups: analysis.groups.length },
      `dedup run: listing ${analysis.groups.length} duplicate group(s) found`,
    );
    for (const group of analysis.groups) {
      logger.info(
        {
          hash: group.hash,
          title: group.title,
          author: group.author,
          count: group.books.length,
          uris: group.books.map((b) => b.uri),
          createdAt: group.books.map((b) => b.createdAt),
        },
        `dedup run: duplicate group (${group.books.length} copies) — ${group.title} by ${group.author}`,
      );
    }
  }

  if (analysis.duplicateGroups === 0) {
    logger.info(
      { totalDurationMs: Date.now() - startTime },
      'dedup run: complete — no duplicates found, skipping merge',
    );
    return;
  }

  logger.info(
    { groups: analysis.duplicateGroups, records: analysis.totalDuplicateRecords },
    'dedup run: step 3/3 — merging duplicates',
  );
  const t3 = Date.now();
  await runMerge(dryRun ? ['--dry-run'] : []);
  logger.info({ durationMs: Date.now() - t3 }, 'dedup run: step 3/3 complete — merge done');

  logger.info(
    { totalDurationMs: Date.now() - startTime, dryRun, merged: analysis.totalDuplicateRecords },
    'dedup run: complete',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.fatal({ err }, 'dedup job failed');
    process.exit(1);
  });
}
