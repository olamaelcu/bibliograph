import { TapClient, type TapEvent } from '@atcute/tap';
import { Client, simpleFetchHandler } from '@atcute/client';
import type { Logger } from 'pino';
import {
  enqueueRecordUpsert,
  enqueueRecordDelete,
  enqueueRecordUpsertBatch,
  enqueueRecordDeleteBatch,
  type TapRecordUpsertItem,
} from './jobs/enqueue';
import { getTapQueueDepth } from './jobs/depth';

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

type UpsertBufferItem = TapRecordUpsertItem & { ack: () => Promise<void> };
type DeleteBufferItem = { uri: string; ack: () => Promise<void> };

function isRecordEvent(e: TapEvent): e is Extract<TapEvent, { type: 'record' }> {
  return e.type === 'record';
}

export async function runTapConsumer(log: Logger): Promise<void> {
  log.info({ tap: TAP_URL, upstream: UPSTREAM_APPVIEW, batchSize: TAP_BATCH_SIZE, batchIntervalMs: TAP_BATCH_INTERVAL_MS }, 'listening to TAP');

  const upsertBuffer: UpsertBufferItem[] = [];
  const deleteBuffer: DeleteBufferItem[] = [];
  let lastFlushAt = Date.now();

  async function flushBuffers(): Promise<void> {
    if (upsertBuffer.length === 0 && deleteBuffer.length === 0) return;
    if (upsertBuffer.length > 0) {
      const items = upsertBuffer.map(({ uri, did, rkey, value }) => ({ uri, did, rkey, value }));
      const acks = upsertBuffer.map(({ ack }) => ack());
      upsertBuffer.length = 0;
      try {
        await enqueueRecordUpsertBatch(items);
        await Promise.all(acks);
      } catch (err) {
        log.error({ stage: 'tap-consumer', err, count: items.length }, 'batch upsert enqueue failed');
        await Promise.all(acks);
      }
    }
    if (deleteBuffer.length > 0) {
      const uris = deleteBuffer.map(({ uri }) => uri);
      const acks = deleteBuffer.map(({ ack }) => ack());
      deleteBuffer.length = 0;
      try {
        await enqueueRecordDeleteBatch(uris);
        await Promise.all(acks);
      } catch (err) {
        log.error({ stage: 'tap-consumer', err, count: uris.length }, 'batch delete enqueue failed');
        await Promise.all(acks);
      }
    }
    lastFlushAt = Date.now();
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

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info(
      { upserts: upsertBuffer.length, deletes: deleteBuffer.length, signal },
      'flushing buffers on shutdown',
    );
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
        await ack();
        continue;
      }
      if (
        !event.collection.startsWith(NET_PREFIX) &&
        event.collection !== REVIEW_COLLECTION
      ) {
        await ack();
        continue;
      }
      // Conditional ack safety net: if the TAP queue is over the threshold, skip
      // both enqueue and ack so TAP redelivers later when workers drain.
      const depth = await getTapQueueDepth();
      if (depth > TAP_QUEUE_DEPTH_THRESHOLD) {
        log.warn({ stage: 'tap-consumer', depth, threshold: TAP_QUEUE_DEPTH_THRESHOLD }, 'queue depth too high; skipping event (TAP will redeliver)');
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
      try { await ack(); } catch { /* ignore */ }
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