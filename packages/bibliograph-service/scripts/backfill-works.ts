#!/usr/bin/env tsx
//
// Reconcile `editions.work_uri` across the entire editions table, then
// re-verify CIDs on already-linked works. Idempotent — safe to re-run.
//
//   pnpm backfill:works
//
// Requires DATABASE_URL. Streams per-row pino logs to logs/worker.*.log and a
// final JSON summary line on stdout. Exits 1 if any row failed.

import { createLogger } from '../src/lib/server/logger';
import { runBackfill } from '../src/lib/server/jobs/backfill-works';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const log = createLogger('worker');
  try {
    const summary = await runBackfill({ log });
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