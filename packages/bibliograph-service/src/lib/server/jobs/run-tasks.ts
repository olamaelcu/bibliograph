// Graphile Worker task list, run inside the worker process.
//
// The TAP consumer is gone; the worker now only drains catalog enrichment and
// the PDS outbox.

import type { Logger } from 'pino';
import { allTaskList } from './handlers';

const CONCURRENCY = Number(process.env.GRAPHILE_WORKER_CONCURRENCY ?? 10);

export async function runJobTasks(log: Logger): Promise<void> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error('DATABASE_URL required');

	const [{ runTaskList }, { Pool }] = await Promise.all([import('graphile-worker'), import('pg')]);

	// Pool maxima are part of the shared connection budget: see db/index.ts.
	const pool = new Pool({
		connectionString,
		max: Number(process.env.GRAPHILE_WORKER_POOL ?? 6),
	});
	pool.on('error', (err) => log.warn({ err }, 'worker pool idle client error'));

	log.info({ concurrency: CONCURRENCY }, 'graphile task list started');
	try {
		await runTaskList({ connectionString, concurrency: CONCURRENCY }, allTaskList, pool);
	} finally {
		await pool.end().catch(() => undefined);
	}
}
