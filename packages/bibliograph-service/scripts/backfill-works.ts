#!/usr/bin/env tsx
//
// Reconcile `editions.work_uri` across the entire editions table, then
// re-verify CIDs on already-linked works. Idempotent — safe to re-run.
//
//   pnpm backfill:works
//   pnpm backfill:works --shard=0/4
//
// A 240k-edition catalog spends this job's whole life waiting on OpenLibrary,
// so the scan can be split into disjoint slices: `--shard=<index>/<count>`, or
// `SHARD_INDEX` + `SHARD_COUNT` for a systemd unit. Each process walks one
// slice and a restart resumes that same slice, because the slice is a function
// of the edition uri (`shardPredicate`).
//
// Editions an earlier pass asked OpenLibrary about and found no match for are
// skipped (`edition_work_backfill`). `--retry-unmatched` ignores those markers
// and asks again — for when the upstream catalog has grown.
//
// Requires DATABASE_URL. Streams per-row pino logs to logs/worker.*.log, paints
// a progress bar per phase on stderr, and prints a final JSON summary line on
// stdout. Exits 1 if any row failed.

import { createLogger } from '../src/lib/server/logger';
import { runBackfill } from '../src/lib/server/jobs/backfill-works';
import { ProgressBar } from './lib/progress';

function parseShard(argv: readonly string[]): { shardIndex: number; shardCount: number } {
  const flag = argv.find((arg) => arg.startsWith('--shard='));
  let index = 0;
  let count = 1;
  if (flag) {
    const [rawIndex, rawCount] = flag.slice('--shard='.length).split('/');
    index = Number(rawIndex);
    count = Number(rawCount);
  } else if (process.env.SHARD_COUNT) {
    index = Number(process.env.SHARD_INDEX ?? 0);
    count = Number(process.env.SHARD_COUNT);
  }
  if (!Number.isInteger(count) || count < 1 || count > 256) {
    throw new Error(`shard count must be an integer in [1, 256], got ${count}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`shard index must be an integer in [0, ${count}), got ${index}`);
  }
  return { shardIndex: index, shardCount: count };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const { shardIndex, shardCount } = parseShard(process.argv.slice(2));
  const log = createLogger('worker');
  const shardLabel = shardCount > 1 ? ` shard ${shardIndex}/${shardCount}` : '';

  // `runBackfill` reports the size of each phase before its first row, so the
  // bar is sized from the real total instead of a guess.
  let bar: ProgressBar | undefined;
  let phase: string | undefined;
  let reported = 0;
  const onProgress = (next: 'orphans' | 'cids', done: number, total: number): void => {
    if (next !== phase) {
      bar?.finish();
      bar = new ProgressBar(`[backfill-works:${next}${shardLabel}]`, total);
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
    const summary = await runBackfill({
      log,
      onProgress,
      shardIndex,
      shardCount,
      retryUnmatched: process.argv.includes('--retry-unmatched'),
    });
    bar?.finish();
    // Emit a single machine-readable summary line so cron / shell pipelines can
    // parse it without grepping pino-formatted text.
    console.log(JSON.stringify({
      stage: 'backfill-works:summary',
      shardIndex,
      shardCount,
      ...summary,
    }));
    // A run that stopped because the catalog lookup was down is not a success:
    // say so in the exit code so a wrapper does not treat it as a finished pass.
    process.exit(summary.failed > 0 || summary.aborted ? 1 : 0);
  } finally {
    // pino.transport holds a worker thread; close it so the process exits.
    setImmediate(() => process.exit(process.exitCode ?? 0));
  }
}

main().catch((err) => {
  console.error('backfill crashed:', err);
  process.exit(2);
});
