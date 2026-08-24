// Companion to src/worker.ts (which runs TAP tap-consumer logic).
// Runs Graphile Worker task handlers for search ingest + tap records.
// Two task lists (separated via separate runTaskList calls) run in the same
// process with different concurrency settings.

import { searchTaskList, tapTaskList } from './lib/server/jobs/handlers';

const SEARCH_CONCURRENCY = Number(process.env.GRAPHILE_WORKER_CONCURRENCY_SEARCH ?? 10);
const TAP_CONCURRENCY = Number(process.env.GRAPHILE_WORKER_CONCURRENCY_TAP ?? 25);

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');

  const [{ runTaskList }, { Pool }] = await Promise.all([
    import('graphile-worker'),
    import('pg'),
  ]);

  const searchPool = new Pool({ connectionString });
  const tapPool = new Pool({ connectionString });

  try {
    await Promise.all([
      runTaskList({ connectionString, concurrency: SEARCH_CONCURRENCY }, searchTaskList, searchPool),
      runTaskList({ connectionString, concurrency: TAP_CONCURRENCY }, tapTaskList, tapPool),
    ]);
  } finally {
    await searchPool.end().catch(() => undefined);
    await tapPool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('worker-search-jobs failed:', err);
  process.exit(1);
});