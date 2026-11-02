// Graphile Worker task lists, run inside the worker process.
//
// This was `src/worker-search-jobs.ts` and its own systemd unit. Folded into the
// TAP consumer's process because on a single-core, 1 GB host a second Node
// runtime (plus the tsx loader) is real memory the web app cannot use: the units
// it replaces measured 15 MB resident and ~30 MB with the loader, against a box
// that had 18 MB available at its worst.
//
// The two lists keep separate pools and concurrency settings: ingest handlers run
// few and slow because they wait on upstream APIs, while tap mirrors run many and
// short because they are local upserts.

import type { Logger } from 'pino';
import { searchTaskList, tapTaskList } from './handlers';

const SEARCH_CONCURRENCY = Number(process.env.GRAPHILE_WORKER_CONCURRENCY_SEARCH ?? 10);
const TAP_CONCURRENCY = Number(process.env.GRAPHILE_WORKER_CONCURRENCY_TAP ?? 25);

export async function runJobTasks(log: Logger): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');

  const [{ runTaskList }, { Pool }] = await Promise.all([
    import('graphile-worker'),
    import('pg'),
  ]);

  const searchPool = new Pool({ connectionString });
  const tapPool = new Pool({ connectionString });

  log.info({ searchConcurrency: SEARCH_CONCURRENCY, tapConcurrency: TAP_CONCURRENCY }, 'graphile task lists started');
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
