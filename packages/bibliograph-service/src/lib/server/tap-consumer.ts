import { TapClient, type TapEvent } from '@atcute/tap';
import { Client, simpleFetchHandler } from '@atcute/client';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db } from './db';
import { editions, records } from './db/schema';

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
  log.info({ tap: TAP_URL, upstream: UPSTREAM_APPVIEW }, 'connecting to TAP');

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
          // TODO: Fire as a background job (import-delete).
          await db.delete(records).where(eq(records.uri, uri));
          log.info({ action: 'delete', uri, collection: event.collection }, 'record');
        } else {
          // TODO: Fire as a background job (import-upsert).
          await db
            .insert(records)
            .values({
              uri,
              cid: event.cid,
              did,
              rkey,
              collection: event.collection,
              value: event.record ?? {},
            })
            .onConflictDoUpdate({
              target: records.uri,
              set: { cid: event.cid, value: event.record ?? {}, indexedAt: new Date() },
            });
          log.info({ action: event.action, uri, collection: event.collection }, 'record');
        }
      }
    } catch (err) {
      log.error({ err }, 'processing error');
    } finally {
      await ack();
    }
  }
}
