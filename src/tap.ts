import { Tap, SimpleIndexer } from '@atproto/tap';
import type { RecordEvent, IdentityEvent, TapChannel } from '@atproto/tap';
import { handleRecordEventQueued } from './indexer.js';
import { logger } from './logger.js';

const TAP_URL = process.env.TAP_URL;
const TAP_ADMIN_PASSWORD = process.env.TAP_ADMIN_PASSWORD;

let channel: TapChannel | null = null;

function getTap(): Tap | null {
  if (!TAP_URL) return null;
  return new Tap(TAP_URL, {
    adminPassword: TAP_ADMIN_PASSWORD,
  });
}

function buildIndexer(): SimpleIndexer {
  const indexer = new SimpleIndexer();

  indexer.identity(async (evt: IdentityEvent) => {
    logger.info({ did: evt.did, handle: evt.handle, isActive: evt.isActive }, 'tap identity event');
  });

  indexer.record((evt: RecordEvent) => {
    return handleRecordEventQueued({
      type: 'record',
      action: evt.action,
      did: evt.did,
      rev: evt.rev,
      collection: evt.collection,
      rkey: evt.rkey,
      record: evt.record as Record<string, unknown> | undefined,
      cid: evt.cid,
      live: evt.live,
    });
  });

  indexer.error((err: Error) => {
    logger.error({ err }, 'tap handler error');
  });

  return indexer;
}

export async function startTapChannel(): Promise<void> {
  const tap = getTap();
  if (!tap) {
    logger.info('TAP_URL not set, skipping Tap WebSocket connection');
    return;
  }

  logger.info({ tapUrl: TAP_URL }, 'starting Tap WebSocket client');
  channel = tap.channel(buildIndexer(), {
    heartbeatIntervalMs: 30_000,
    onReconnectError: (error: unknown, attempt: number, initialSetup: boolean) => {
      logger.warn({ error, attempt, initialSetup }, 'tap reconnect error');
    },
  });
  await channel.start();
}

export async function stopTapChannel(): Promise<void> {
  if (channel) {
    logger.info('stopping Tap WebSocket client');
    await channel.destroy();
    channel = null;
    logger.info('Tap WebSocket client stopped');
  }
}

export async function trackRepos(dids: string[]): Promise<void> {
  if (dids.length === 0) return;
  const tap = getTap();
  if (!tap) return;

  logger.info({ count: dids.length }, 'adding repos to Tap');
  await tap.addRepos(dids);
  logger.info({ count: dids.length }, 'repos added to Tap');
}
