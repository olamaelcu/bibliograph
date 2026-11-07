#!/usr/bin/env tsx
// Re-enqueue ISBN lookups for editions an earlier run already checked.
//
// The daily scan only sees editions with no `edition_isbn_enrichment` row, so a
// row stamped `none` or `shadow` is terminal. That is correct for a fixed set of
// providers, but the search side changed: OpenLibrary (edition-precise ISBNs)
// and Goodreads are consulted again, so the rows whose search ran before them
// deserve one more pass. `--result` picks which verdict to retry:
//
//   --result=shadow  (default) rows the old shadow tier recorded and never wrote
//   --result=none    rows whose search returned no acceptable ISBN
//
// Idempotent: a row that gains an ISBN is excluded by the ISBN predicate, and a
// re-run that decides the same way rewrites the same enrichment row. Rows are
// only retried once their verdict is `--older-than-days` old (default 30; `0`
// disables the cooldown), so repeated runs do not re-ask the same backlog.
//
// Run from the package root (an operator does):
//   node_modules/.bin/tsx scripts/requeue-isbn-enrichment.ts --result=none
//
// Locally:
//   pnpm tsx scripts/requeue-isbn-enrichment.ts --dry-run --result=none
//   pnpm tsx scripts/requeue-isbn-enrichment.ts --limit 50

import { and, inArray, notInArray, sql } from 'drizzle-orm';
import { makeWorkerUtils } from 'graphile-worker';
import { db } from '../src/lib/server/db';
import { ProgressBar } from './lib/progress';
import { queuedIsbnBackfillUris } from './lib/queue';
import { editions } from '../src/lib/server/db/schema';

const RESULT_VALUES = ['shadow', 'none', 'ambiguous'] as const;
type RequeueResult = (typeof RESULT_VALUES)[number];

interface Options {
  dryRun: boolean;
  limit: number;
  result: RequeueResult;
  /** Skip rows checked more recently than this many days. */
  olderThanDays: number;
}

function isRequeueResult(value: string): value is RequeueResult {
  return (RESULT_VALUES as readonly string[]).includes(value);
}

function parseArgs(argv: string[]): Options {
  let limit = 5000;
  let result: RequeueResult = 'shadow';
  let olderThanDays = 30;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') continue;
    if (arg.startsWith('--older-than-days=')) {
      olderThanDays = Number(arg.slice('--older-than-days='.length));
      continue;
    }
    if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length));
      continue;
    }
    if (arg === '--limit') {
      limit = Number(argv[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith('--result=')) {
      const value = arg.slice('--result='.length);
      if (!isRequeueResult(value)) throw new Error(`--result must be one of ${RESULT_VALUES.join(', ')}`);
      result = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit must be a positive number');
  // 0 disables the cooldown (re-ask everything still lacking an ISBN).
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error('--older-than-days must be zero or a positive number');
  }
  return { dryRun: argv.includes('--dry-run'), limit, result, olderThanDays };
}

/**
 * Editions with the chosen verdict, still no ISBN, and not checked recently.
 *
 * A retry that decides the same way rewrites the verdict, so without the
 * recency guard every run would re-ask the whole backlog — a re-stamped `none`
 * is still `none`.
 */
function pendingFor(result: RequeueResult, olderThanDays: number) {
  return sql`
    EXISTS (
      SELECT 1 FROM edition_isbn_enrichment e
       WHERE e.uri = ${editions.uri}
         AND e.result = ${result}
         AND e.checked_at < now() - make_interval(days => ${olderThanDays})
    )
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${editions.identifiers}) AS ident
       WHERE ident->>'type' = 'isbn'
    )
  `;
}

async function run(): Promise<void> {
  const { dryRun, limit, result, olderThanDays } = parseArgs(process.argv.slice(2));

  const queued = await queuedIsbnBackfillUris();
  const queuedUris = [...queued];
  const rows = await db
    .select({ uri: editions.uri, rkey: editions.rkey })
    .from(editions)
    .where(
      queuedUris.length > 0
        ? and(pendingFor(result, olderThanDays), notInArray(editions.uri, queuedUris))
        : pendingFor(result, olderThanDays),
    )
    .orderBy(editions.indexedAt)
    .limit(limit);

  console.log(
    `[requeue-isbn-enrichment] ${rows.length} edition(s) stamped '${result}' still lack an ISBN (unchecked for ${olderThanDays}+ days)`,
  );

  if (dryRun) {
    console.log('[requeue-isbn-enrichment] dry run: nothing enqueued');
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[requeue-isbn-enrichment] DATABASE_URL is required');
    process.exit(1);
  }
  const utils = await makeWorkerUtils({ connectionString: url });

  const bar = new ProgressBar('[requeue-isbn-enrichment]', rows.length);
  try {
    for (const row of rows) {
      await utils.addJob(
        'backfill-edition-isbn',
        { uri: row.uri, rkey: row.rkey },
        { jobKey: `backfill-isbn:${row.uri}`, maxAttempts: 5 },
      );
      bar.advance();
    }
  } finally {
    await utils.release();
  }

  bar.finish();
  console.log(`[requeue-isbn-enrichment] enqueued ${bar.done} job(s)`);
}

run().catch((err) => {
  console.error('[requeue-isbn-enrichment] failed', err);
  process.exit(1);
});
