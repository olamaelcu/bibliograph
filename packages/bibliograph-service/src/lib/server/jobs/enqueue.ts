import type { WorkerUtils } from 'graphile-worker';
import type { BackfillSource } from './backfill-audit';
import type { EditionItem } from '../search/types.ts';

let utilsPromise: Promise<WorkerUtils> | undefined;

/** Jobs per `addJobs` call: graphile inserts the chunk in one statement. */
const ENQUEUE_CHUNK = 1_000;

async function getUtils(): Promise<WorkerUtils> {
	if (!utilsPromise) {
		const { makeWorkerUtils } = await import('graphile-worker');
		const { Pool } = await import('pg');
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error('DATABASE_URL is required for job enqueue');
		const pool = new Pool({ connectionString, max: Number(process.env.ENQUEUE_POOL_MAX ?? 3) });
		pool.on('error', (err) => {
			console.error('[enqueue] idle client error', err);
		});
		utilsPromise = makeWorkerUtils({ pgPool: pool });
	}
	return utilsPromise;
}

export async function enqueueIngest(kind: 'edition', item: EditionItem): Promise<void> {
	const utils = await getUtils();
	await utils.addJob(`ingest-${kind}`, item);
}

export async function enqueueIngestBatch(kind: 'edition', items: EditionItem[]): Promise<void> {
	if (items.length === 0) return;
	const utils = await getUtils();
	await utils.addJob(`ingest-${kind}-batch`, items);
}

export async function enqueueCoverBackfill(uri: string, rkey: string, source?: BackfillSource): Promise<void> {
	const utils = await getUtils();
	await utils.addJob('backfill-edition-cover', { uri, rkey, source }, {
		jobKey: `backfill-cover:${uri}`,
		maxAttempts: 5,
	});
}

export async function enqueueDescriptionBackfill(uri: string, source?: BackfillSource): Promise<void> {
	const utils = await getUtils();
	await utils.addJob('backfill-edition-description', { uri, source }, {
		jobKey: `backfill-description:${uri}`,
		maxAttempts: 5,
	});
}

export async function enqueueFormatBackfill(uri: string, source?: BackfillSource): Promise<void> {
	const utils = await getUtils();
	await utils.addJob('backfill-edition-format', { uri, source }, {
		jobKey: `backfill-format:${uri}`,
		maxAttempts: 5,
	});
}

export async function enqueueIsbnBackfill(uri: string, rkey: string, source?: BackfillSource): Promise<void> {
	const utils = await getUtils();
	await utils.addJob('backfill-edition-isbn', { uri, rkey, source }, {
		jobKey: `backfill-isbn:${uri}`,
		maxAttempts: 5,
	});
}

/** Enqueue one outbox drain; the job re-queues itself while rows remain. */
export async function enqueuePdsPublish(): Promise<void> {
	const utils = await getUtils();
	await utils.addJob('pds-publish', {}, { jobKey: 'pds-publish', maxAttempts: 3 });
}

export { ENQUEUE_CHUNK };
