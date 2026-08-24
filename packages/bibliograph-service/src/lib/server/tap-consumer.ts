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

const TAP_URL = process.env.TAP_URL ?? 'http://localhost:2480';
const UPSTREAM_APPVIEW = process.env.UPSTREAM_APPVIEW ?? 'https://public.api.bsky.app';
const TAP_BATCH_SIZE = Number(process.env.TAP_BATCH_SIZE ?? 100);
const TAP_BATCH_INTERVAL_MS = Number(process.env.TAP_BATCH_INTERVAL_MS ?? 500);

export const verifyClient = new Client({
  handler: simpleFetchHandler({ service: UPSTREAM_APPVIEW }),
});

const tap = new TapClient({ url: TAP_URL });

const NET_PREFIX = 'net.olamaelcu.livtet.biblio.';

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

  async function shutdown(): Promise<void> {
    log.info({ upserts: upsertBuffer.length, deletes: deleteBuffer.length }, 'flushing buffers on shutdown');
    await flushBuffers();
  }
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });

  for await (const { event, ack } of tap.subscribe()) {
    try {
      if (!isRecordEvent(event)) {
        await ack();
        continue;
      }
      if (!event.collection.startsWith(NET_PREFIX)) {
        await ack();
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
}