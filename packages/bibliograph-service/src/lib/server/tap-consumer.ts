import { TapClient, type TapEvent } from '@atcute/tap';
import { Client, simpleFetchHandler } from '@atcute/client';
import type { Logger } from 'pino';
import { db } from './db';
import { editions, records } from './db/schema';
import { enqueueRecordUpsert, enqueueRecordDelete } from './jobs/enqueue';

const TAP_URL = process.env.TAP_URL ?? 'http://localhost:2480';
const UPSTREAM_APPVIEW = process.env.UPSTREAM_APPVIEW ?? 'https://public.api.bsky.app';

// Wired in for cross-record verification (resolve contributor/work/publisher strongRefs
// against the upstream AppView configured by UPSTREAM_APPVIEW). Available to use; not
// invoked on every event in MVP — wire into the upsert loop where you need it.
export const verifyClient = new Client({
  handler: simpleFetchHandler({ service: UPSTREAM_APPVIEW }),
});

const tap = new TapClient({ url: TAP_URL });

const EDITION_COLLECTION = 'community.lexicon.book.edition';
const NET_PREFIX = 'net.olamaelcu.livtet.biblio.';

type EditionRecord = {
  title?: string;
  subtitle?: string;
  work?: { uri?: string; cid?: string };
  publisher?: { uri?: string; cid?: string };
  place?: string;
  publishedYear?: number;
  language?: string;
  contributors?: Array<{ subject: { uri: string; cid: string }; role: string }>;
  identifiers?: Array<{ uri: string; resource: string }>;
  description?: string;
  createdAt?: string;
};

function isRecordEvent(e: TapEvent): e is Extract<TapEvent, { type: 'record' }> {
  return e.type === 'record';
}

export async function runTapConsumer(log: Logger): Promise<void> {
  log.info({ tap: TAP_URL, upstream: UPSTREAM_APPVIEW }, 'listening to TAP');

  for await (const { event, ack } of tap.subscribe()) {
    try {
      if (!isRecordEvent(event)) {
        await ack();
        continue;
      }

      const uri = `at://${event.did}/${event.collection}/${event.rkey}`;
      const { did, rkey } = { did: event.did, rkey: event.rkey };

      if (event.collection.startsWith(NET_PREFIX)) {
        if (event.action === 'delete') {
          await enqueueRecordDelete(uri);
          log.info({ action: 'delete', uri, collection: event.collection }, 'record enqueued');
        } else {
          await enqueueRecordUpsert(uri, did, rkey, (event.record ?? {}) as Record<string, unknown>);
          log.info({ action: event.action, uri, collection: event.collection }, 'record enqueued');
        }
      }
    } catch (err) {
      log.error({ err }, 'processing error');
    } finally {
      await ack();
    }
  }
}
