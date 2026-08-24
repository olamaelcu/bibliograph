import type { WorkerUtils } from 'graphile-worker';
import type { EditionItem, WorkItem, ContributorItem } from '../search/types.ts';

type IngestItem = EditionItem | WorkItem | ContributorItem;

let utilsPromise: Promise<WorkerUtils> | undefined;

async function getUtils(): Promise<WorkerUtils> {
  if (!utilsPromise) {
    const { makeWorkerUtils } = await import('graphile-worker');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required for job enqueue');
    utilsPromise = makeWorkerUtils({ connectionString });
  }
  return utilsPromise;
}

export async function enqueueIngest(
  kind: 'edition' | 'work' | 'contributor',
  item: IngestItem,
): Promise<void> {
  const utils = await getUtils();
  await utils.addJob(`ingest-${kind}`, item);
}

export async function enqueueRecordUpsert(
  uri: string,
  did: string,
  rkey: string,
  value: Record<string, unknown>,
): Promise<void> {
  const utils = await getUtils();
  await utils.addJob('tap-record-upsert', { uri, did, rkey, value });
}

export async function enqueueRecordDelete(uri: string): Promise<void> {
  const utils = await getUtils();
  await utils.addJob('tap-record-delete', { uri });
}