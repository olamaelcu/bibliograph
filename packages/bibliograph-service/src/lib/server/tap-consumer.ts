import { TapClient, type TapEvent } from '@atcute/tap';
import { Client, simpleFetchHandler } from '@atcute/client';
import type { Logger } from 'pino';
import {
  enqueueRecordUpsertBatch,
  enqueueRecordDeleteBatch,
  type TapRecordUpsertItem,
} from './jobs/enqueue';
import { BOOKHIVE_BOOK_COLLECTION } from './bookhive/keys';
import { getTapQueueDepth } from './jobs/depth';
import { uniqueUris } from './jobs/tap-batch';
import {
  tapAckFailuresTotal,
  tapDuplicateEventsTotal,
  tapEnqueueFailuresTotal,
  tapOutboxBuffer,
  tapResyncBuffer,
} from './metrics';
import { fetchTapStats } from './tap-stats';

const TAP_URL = process.env.TAP_URL ?? 'http://localhost:2480';
// TAP's /channel requires basic auth; without this the socket is rejected 401.
const TAP_ADMIN_PASSWORD = process.env.TAP_ADMIN_PASSWORD;
const UPSTREAM_APPVIEW = process.env.UPSTREAM_APPVIEW ?? 'https://public.api.bsky.app';
const TAP_BATCH_SIZE = Number(process.env.TAP_BATCH_SIZE ?? 100);
const TAP_BATCH_INTERVAL_MS = Number(process.env.TAP_BATCH_INTERVAL_MS ?? 500);
const TAP_QUEUE_DEPTH_THRESHOLD = Number(process.env.TAP_QUEUE_DEPTH_THRESHOLD ?? 50_000);

export const verifyClient = new Client({
  handler: simpleFetchHandler({ service: UPSTREAM_APPVIEW }),
});

const tap = new TapClient({
  url: TAP_URL,
  ...(TAP_ADMIN_PASSWORD ? { adminPassword: TAP_ADMIN_PASSWORD } : {}),
});

const NET_PREFIX = 'net.olamaelcu.livtet.biblio.';
const REVIEW_COLLECTION = 'net.olamaelcu.livtet.bookReview';
// Bookhive users' own book records carry their reviews and reading status, so
// mirroring them is what lets those reviews show up in Bibliograph feeds.
const MIRRORED_COLLECTIONS = new Set([REVIEW_COLLECTION, BOOKHIVE_BOOK_COLLECTION]);

type UpsertBufferItem = TapRecordUpsertItem & { ack: () => Promise<void> };
type DeleteBufferItem = { uri: string; ack: () => Promise<void> };

function isRecordEvent(e: TapEvent): e is Extract<TapEvent, { type: 'record' }> {
  return e.type === 'record';
}

/**
 * Acknowledge events TAP already has durably recorded in our queue.
 *
 * The acks are deliberately **not awaited**: `@atcute/tap` drains its ack queue as
 * messages arrive, so awaiting them inside the read loop parks the loop while the
 * server waits for the acks — which is exactly how ingestion stalled for 14
 * minutes on 2026-11-02 with 2,863 events stuck in TAP's outbox. Queueing them and
 * keeping the loop reading lets the client flush them in its own order; an ack
 * lost to a crash only means TAP redelivers, and every upsert is keyed by uri.
 */
function ackEvents(batch: Array<{ ack: () => Promise<void> }>, log: Logger): void {
  for (const item of batch) {
    void item.ack().catch((err: unknown) => {
      tapAckFailuresTotal.inc(1);
      log.warn({ err }, 'ack failed; TAP will redeliver the event');
    });
  }
}

/**
 * How far behind we are, as the larger of TAP's outbox and our own job queue.
 *
 * TAP's `/stats/outbox-buffer` is the honest number — an unacked event waits
 * there, and `/channel` has no cursor to resume from. The job table is the
 * fallback for a TAP build that does not publish stats, so an unavailable
 * reading never reads as "no backlog".
 */
async function tapBacklog(): Promise<number> {
  const stats = await fetchTapStats(TAP_URL);
  if (stats) {
    tapOutboxBuffer.set(stats.outboxBuffer);
    tapResyncBuffer.set(stats.resyncBuffer);
  }
  const jobs = await getTapQueueDepth().catch(() => 0);
  return Math.max(stats?.outboxBuffer ?? 0, jobs);
}

export async function runTapConsumer(log: Logger): Promise<void> {
  log.info({ tap: TAP_URL, upstream: UPSTREAM_APPVIEW, batchSize: TAP_BATCH_SIZE, batchIntervalMs: TAP_BATCH_INTERVAL_MS }, 'listening to TAP');

  const upsertBuffer: UpsertBufferItem[] = [];
  const deleteBuffer: DeleteBufferItem[] = [];
  let lastFlushAt = Date.now();
  let flushing = false;

  async function flushBuffers(): Promise<void> {
    if (upsertBuffer.length === 0 && deleteBuffer.length === 0) return;
    if (flushing) return;
    flushing = true;
    try {
      if (upsertBuffer.length > 0) {
        const batch = upsertBuffer.splice(0, upsertBuffer.length);
        // One payload per uri before it reaches a job. The acks stay one per
        // event: TAP still has to forget the duplicates we collapsed, and the
        // task dedupes again so a redelivery landing in a later batch is safe
        // too.
        const latest = new Map<string, TapRecordUpsertItem>();
        for (const { uri, did, rkey, value } of batch) {
          latest.set(uri, { uri, did, rkey, value });
        }
        const items = [...latest.values()];
        if (items.length < batch.length) {
          tapDuplicateEventsTotal.inc({ stage: 'upsert' }, batch.length - items.length);
        }
        try {
          await enqueueRecordUpsertBatch(items);
        } catch (err) {
          // No ack on failure: the events stay TAP's responsibility and its outbox
          // redelivers them. Dropping them from the buffer keeps memory bounded,
          // and acking here — which this used to do — lost the records outright.
          tapEnqueueFailuresTotal.inc({ task: 'tap-record-upsert-batch' });
          log.error({ stage: 'tap-consumer', err, count: items.length }, 'batch upsert enqueue failed; leaving events unacked for redelivery');
          return;
        }
        ackEvents(batch, log);
      }
      if (deleteBuffer.length > 0) {
        const batch = deleteBuffer.splice(0, deleteBuffer.length);
        const uris = uniqueUris(batch.map(({ uri }) => uri));
        if (uris.length < batch.length) {
          tapDuplicateEventsTotal.inc({ stage: 'delete' }, batch.length - uris.length);
        }
        try {
          await enqueueRecordDeleteBatch(uris);
        } catch (err) {
          tapEnqueueFailuresTotal.inc({ task: 'tap-record-delete-batch' });
          log.error({ stage: 'tap-consumer', err, count: uris.length }, 'batch delete enqueue failed; leaving events unacked for redelivery');
          return;
        }
        ackEvents(batch, log);
      }
    } finally {
      lastFlushAt = Date.now();
      flushing = false;
    }
  }

  function shouldFlush(): boolean {
    const size = upsertBuffer.length + deleteBuffer.length;
    if (size >= TAP_BATCH_SIZE) return true;
    if (size > 0 && Date.now() - lastFlushAt >= TAP_BATCH_INTERVAL_MS) return true;
    return false;
  }

  const subscription = tap.subscribe();
  const events = subscription[Symbol.asyncIterator]();
  let stopping = false;

  // A timer, not an "on next event" check: a quiet tail would otherwise leave the
  // last events buffered and unacked until TAP's outbox timed out and redelivered
  // them, which is what made a one-event trickle look like a retry storm.
  const flushTimer = setInterval(() => { void flushBuffers(); }, TAP_BATCH_INTERVAL_MS);
  flushTimer.unref();

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info(
      { upserts: upsertBuffer.length, deletes: deleteBuffer.length, signal },
      'flushing buffers on shutdown',
    );
    clearInterval(flushTimer);
    // Never let systemd reach TimeoutStopSec and SIGKILL us.
    setTimeout(() => process.exit(0), 5_000).unref();
    await flushBuffers();
    // Ask the subscription to close the websocket, but do NOT await it: the
    // for-await loop below is parked on next(), and the iterator's return()
    // does not settle that pending next(), so awaiting it would hang the
    // process until the timer above fired. 200ms is enough for the close frame
    // to leave, and the exit below closes whatever is left.
    await Promise.race([
      events.return?.() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 200).unref()),
    ]);
    process.exit(0);
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });

  for await (const { event, ack } of events) {
    try {
      if (!isRecordEvent(event)) {
        ackEvents([{ ack }], log);
        continue;
      }
      if (
        !event.collection.startsWith(NET_PREFIX) &&
        !MIRRORED_COLLECTIONS.has(event.collection)
      ) {
        ackEvents([{ ack }], log);
        continue;
      }
      // Backpressure check: skip both enqueue and ack so TAP redelivers later,
      // when the queue has drained. TAP's own outbox is the number that says we
      // are behind — `/channel` has no cursor, so an unacked event is precisely
      // what waits — and our job table is the backstop for a build that does not
      // publish stats.
      const backlog = await tapBacklog();
      if (backlog > TAP_QUEUE_DEPTH_THRESHOLD) {
        log.warn({ stage: 'tap-consumer', backlog, threshold: TAP_QUEUE_DEPTH_THRESHOLD }, 'backlog over threshold; skipping event (TAP will redeliver)');
        continue;
      }
      const uri = `at://${event.did}/${event.collection}/${event.rkey}`;
      if (event.action === 'delete') {
        deleteBuffer.push({ uri, ack });
      } else {
        upsertBuffer.push({ uri, did: event.did, rkey: event.rkey, value: (event.record ?? {}) as Record<string, unknown>, ack });
      }
      if (shouldFlush()) await flushBuffers();
    } catch (err) {
      log.error({ err }, 'processing error');
      ackEvents([{ ack }], log);
    }
  }
  await flushBuffers();

  // Reaching the end without a signal means TAP closed the subscription. Exiting
  // 0 would look like a clean stop to systemd, whose Restart=on-failure would
  // then never bring the consumer back, so this is deliberately a failure.
  if (!stopping) {
    throw new Error('TAP subscription ended unexpectedly');
  }
}