#!/usr/bin/env tsx
//
// Reconcile `editions.work_uri` across the entire editions table, then
// re-verify CIDs on already-linked works. Idempotent — safe to re-run.
//
//   pnpm backfill:works
//
// Requires DATABASE_URL. Streams per-row pino logs to logs/worker.*.log, paints
// a progress bar per phase on stderr, and prints a final JSON summary line on
// stdout. Exits 1 if any row failed.

import { createLogger } from '../src/lib/server/logger';
import { runBackfill } from '../src/lib/server/jobs/backfill-works';
import { ProgressBar } from './lib/progress';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const log = createLogger('worker');

  // `runBackfill` reports the size of each phase before its first row, so the
  // bar is sized from the real total instead of a guess.
  let bar: ProgressBar | undefined;
  let phase: string | undefined;
  let reported = 0;
  const onProgress = (next: 'orphans' | 'cids', done: number, total: number): void => {
    if (next !== phase) {
      bar?.finish();
      bar = new ProgressBar(`[backfill-works:${next}]`, total);
      phase = next;
      reported = 0;
    }
    // The first call of a phase carries `done: 0` and only exists to size the
    // bar; advance by the difference so a skipped callback cannot drift it.
    if (done > reported) {
      bar?.advance(done - reported);
      reported = done;
    }
  };

  try {
    const summary = await runBackfill({ log, onProgress });
    bar?.finish();
    // Emit a single machine-readable summary line so cron / shell pipelines can
    // parse it without grepping pino-formatted text.
    console.log(JSON.stringify({ stage: 'backfill-works:summary', ...summary }));
    process.exit(summary.failed > 0 ? 1 : 0);
  } finally {
    // pino.transport holds a worker thread; close it so the process exits.
    setImmediate(() => process.exit(process.exitCode ?? 0));
  }
}

main().catch((err) => {
  console.error('backfill crashed:', err);
  process.exit(2);
});
