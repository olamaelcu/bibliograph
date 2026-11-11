import type { WorkerUtils } from 'graphile-worker';
import type { BackfillSource } from './backfill-audit';
import type { EditionItem, WorkItem, ContributorItem } from '../search/types.ts';

type IngestItem = EditionItem | WorkItem | ContributorItem;

/**
 * How many times graphile retries one TAP job before it is treated as dead.
 *
 * The TAP tasks used to dead-letter and return success, so nothing was ever
 * retried and nothing read the dead-letter table. They now rethrow, and this cap
 * is what keeps a genuinely poison batch from retrying for hours: on the last
 * attempt the handler writes its dead-letter rows and finishes.
 */
export const MAX_TAP_ATTEMPTS = 5;

let utilsPromise: Promise<WorkerUtils> | undefined;

/** Jobs per `addJobs` call: graphile inserts the chunk in one statement. */
const ENQUEUE_CHUNK = 1_000;

async function getUtils(): Promise<WorkerUtils> {
  if (!utilsPromise) {
    const { makeWorkerUtils } = await import('graphile-worker');
    const { Pool } = await import('pg');
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required for job enqueue');
    // Bounded pool: enqueueing is quick, and the shared budget cannot spare a
    // pg default of 10 per process (see db/index.ts).
    utilsPromise = makeWorkerUtils({
      pgPool: new Pool({ connectionString, max: Number(process.env.ENQUEUE_POOL_MAX ?? 3) }),
    });
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

export async function enqueueIngestBatch(
  kind: 'edition' | 'work' | 'contributor',
  items: IngestItem[],
): Promise<void> {
  if (items.length === 0) return;
  const utils = await getUtils();
  await utils.addJob(`ingest-${kind}-batch`, items);
}

export async function enqueueRecordUpsert(
  uri: string,
  did: string,
  rkey: string,
  value: Record<string, unknown>,
): Promise<void> {
  const utils = await getUtils();
  await utils.addJob('tap-record-upsert', { uri, did, rkey, value }, { maxAttempts: MAX_TAP_ATTEMPTS });
}

export async function enqueueRecordDelete(uri: string): Promise<void> {
  const utils = await getUtils();
  await utils.addJob('tap-record-delete', { uri }, { maxAttempts: MAX_TAP_ATTEMPTS });
}

export interface TapRecordUpsertItem {
  uri: string;
  did: string;
  rkey: string;
  value: Record<string, unknown>;
}

export async function enqueueRecordUpsertBatch(items: TapRecordUpsertItem[]): Promise<void> {
  if (items.length === 0) return;
  const utils = await getUtils();
  await utils.addJob('tap-record-upsert-batch', items, { maxAttempts: MAX_TAP_ATTEMPTS });
}

export async function enqueueRecordDeleteBatch(uris: string[]): Promise<void> {
  if (uris.length === 0) return;
  const utils = await getUtils();
  await utils.addJob('tap-record-delete-batch', uris, { maxAttempts: MAX_TAP_ATTEMPTS });
}

/**
 * Split a failing batch into per-record jobs.
 *
 * One unreadable record used to poison the whole hundred-event batch. Once the
 * batch task has failed twice it hands every record to the single-record task, so
 * the healthy ones land and only the offender burns its own attempts. `addJobs`
 * writes them in one transaction per chunk instead of one `addJob` round trip
 * each.
 */
export async function enqueueRecordUpsertItems(items: TapRecordUpsertItem[]): Promise<void> {
  if (items.length === 0) return;
  const utils = await getUtils();
  const jobs = items.map((item) => ({
    identifier: 'tap-record-upsert',
    payload: item,
    maxAttempts: MAX_TAP_ATTEMPTS,
  }));
  for (let i = 0; i < jobs.length; i += ENQUEUE_CHUNK) {
    await utils.addJobs(jobs.slice(i, i + ENQUEUE_CHUNK));
  }
}

export async function enqueueRecordDeleteItems(uris: string[]): Promise<void> {
  if (uris.length === 0) return;
  const utils = await getUtils();
  const jobs = uris.map((uri) => ({
    identifier: 'tap-record-delete',
    payload: { uri },
    maxAttempts: MAX_TAP_ATTEMPTS,
  }));
  for (let i = 0; i < jobs.length; i += ENQUEUE_CHUNK) {
    await utils.addJobs(jobs.slice(i, i + ENQUEUE_CHUNK));
  }
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

/**
 * Ask for a catalog edition a shelf record references but the catalog lacks.
 * The jobKey keeps a relaunch from stacking duplicates while one is still
 * pending, and the task itself re-checks the row, so a later ingest winning the
 * race is not an error.
 */
export async function enqueueShelvingEditionBackfill(uri: string, source?: BackfillSource): Promise<void> {
  const utils = await getUtils();
  await utils.addJob('backfill-shelving-edition', { uri, source }, {
    jobKey: `backfill-shelving-edition:${uri}`,
    maxAttempts: 3,
  });
}

/** `enqueueShelvingEditionBackfill` for a whole page, in one statement per chunk. */
export async function enqueueShelvingEditionBackfills(uris: readonly string[], source?: BackfillSource): Promise<void> {
  if (uris.length === 0) return;
  const utils = await getUtils();
  const jobs = uris.map((uri) => ({
    identifier: 'backfill-shelving-edition',
    payload: { uri, source },
    jobKey: `backfill-shelving-edition:${uri}`,
    maxAttempts: 3,
  }));
  for (let i = 0; i < jobs.length; i += ENQUEUE_CHUNK) {
    await utils.addJobs(jobs.slice(i, i + ENQUEUE_CHUNK));
  }
}

/**
 * Resolve one contributor's portrait through the Wikidata/Commons resolver and
 * store it on the contributor row, where `getImageForContributor` reads it.
 *
 * The jobKey is what makes a page of portraits cheap: every tile renders the
 * same call, and without dedupe each render would enqueue another lookup for a
 * contributor the resolver has nothing for.
 */
export async function enqueueContributorImageBackfill(uri: string, source?: BackfillSource): Promise<void> {
  const utils = await getUtils();
  await utils.addJob('backfill-contributor-image', { uri, source }, {
    jobKey: `backfill-contributor-image:${uri}`,
    maxAttempts: 5,
  });
}

/**
 * Fill one contributor's bio from Wikipedia. Same jobKey contract as the
 * image backfill: the admin button and any future scanner re-click without
 * stacking duplicates.
 */
export async function enqueueContributorBioBackfill(uri: string, source?: BackfillSource): Promise<void> {
  const utils = await getUtils();
  await utils.addJob('backfill-contributor-bio', { uri, source }, {
    jobKey: `backfill-bio:${uri}`,
    maxAttempts: 5,
  });
}