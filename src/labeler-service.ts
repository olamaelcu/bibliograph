import { ComAtprotoLabelSubscribeLabels, ComAtprotoLabelDefs } from '@atcute/atproto';
import { XRPCRouter, type SubscriptionHandler, type SubscriptionContext } from '@atcute/xrpc-server';
import { createNodeWebSocket } from '@atcute/xrpc-server-node';
import { createServer } from 'node:http';
import { getLabelEvents, getActiveLabels, type LabelEventEntry, type LabelEntry } from './labeler.js';
import { logger } from './logger.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface LabelerServiceOptions {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

type Labels = ComAtprotoLabelSubscribeLabels.Labels & { $type: 'com.atproto.label.subscribeLabels#labels' };
type Info = ComAtprotoLabelSubscribeLabels.Info & { $type: 'com.atproto.label.subscribeLabels#info' };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

type Label = ComAtprotoLabelDefs.Label;
type Did = `did:${string}:${string}`;
type AtUri = `${string}:${string}`;

function toLabel(e: LabelEventEntry): Label {
  return {
    src: e.src as Did,
    uri: e.uri as AtUri,
    val: e.val,
    cts: e.cts,
    neg: e.neg,
  };
}

function snapshotLabels(labels: LabelEntry[]): Label[] {
  return labels.map((l) => ({
    src: l.src as Did,
    uri: l.uri as AtUri,
    val: l.val,
    cts: l.cts,
    neg: l.neg,
  }));
}

/**
 * Build the `com.atproto.label.subscribeLabels` subscription handler.
 *
 * - Without a cursor: emits an initial snapshot of all active labels, then live events.
 * - With a cursor: backfills events with `id > cursor`, then live events.
 *
 * The handler is an async generator; the router encodes each yielded message as a
 * CBOR frame. The generator terminates when the client disconnects (`signal`).
 */
export function createSubscribeLabelsHandler(
  options: LabelerServiceOptions = {},
): SubscriptionHandler<typeof ComAtprotoLabelSubscribeLabels.mainSchema> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  return async function* handler(context: SubscriptionContext<typeof ComAtprotoLabelSubscribeLabels.mainSchema>) {
    const { params, signal } = context;
    const cursor = params.cursor;

    let lastSeq = 0;

    if (cursor !== undefined) {
      if (cursor < 0) {
        const info: Info = { $type: 'com.atproto.label.subscribeLabels#info', name: 'OutdatedCursor' };
        yield info;
      } else {
        const events = getLabelEvents(cursor);
        if (events.length > 0) {
          lastSeq = events[events.length - 1].id;
          const labels: Labels = {
            $type: 'com.atproto.label.subscribeLabels#labels',
            seq: lastSeq,
            labels: events.map(toLabel),
          };
          yield labels;
        } else {
          lastSeq = cursor;
        }
      }
    } else {
      const active = getActiveLabels();
      const latest = getLabelEvents();
      lastSeq = latest.length > 0 ? latest[latest.length - 1].id : 0;
      const labels: Labels = {
        $type: 'com.atproto.label.subscribeLabels#labels',
        seq: lastSeq,
        labels: snapshotLabels(active),
      };
      yield labels;
    }

    let lastHeartbeat = Date.now();

    while (!signal.aborted) {
      await sleep(pollIntervalMs, signal);
      if (signal.aborted) break;

      const events = getLabelEvents(lastSeq);
      if (events.length > 0) {
        lastSeq = events[events.length - 1].id;
        const labels: Labels = {
          $type: 'com.atproto.label.subscribeLabels#labels',
          seq: lastSeq,
          labels: events.map(toLabel),
        };
        yield labels;
        lastHeartbeat = Date.now();
      } else if (Date.now() - lastHeartbeat >= heartbeatIntervalMs) {
        const info: Info = { $type: 'com.atproto.label.subscribeLabels#info', name: 'Heartbeat' };
        yield info;
        lastHeartbeat = Date.now();
      }
    }

    logger.info({ seq: lastSeq }, 'subscribeLabels client disconnected');
  };
}

const PORT = parseInt(process.env.LABELER_PORT || process.env.PORT || '3001', 10);

function buildRouter(nodeWs: ReturnType<typeof createNodeWebSocket>): XRPCRouter {
  const router = new XRPCRouter({ websocket: nodeWs.adapter });
  router.addSubscription(ComAtprotoLabelSubscribeLabels, {
    handler: createSubscribeLabelsHandler(),
  });
  return router;
}

export function createLabelerServer() {
  const nodeWs = createNodeWebSocket();
  const router = buildRouter(nodeWs);
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
    const request = new Request(url, { method: req.method, headers });
    router.fetch(request).then(
      (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(response.body ? response.body : null);
      },
      (err) => {
        logger.error({ err }, 'router.fetch failed');
        res.writeHead(500);
        res.end('Internal Server Error');
      },
    );
  });
  nodeWs.injectWebSocket(server, router);
  return server;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  const entry = process.argv[1].replace(/\\/g, '/');
  return entry.endsWith('/labeler-service.ts') || entry.endsWith('/labeler-service.js');
}

if (isMain()) {
  const server = createLabelerServer();
  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'labeler service listening');
  });

  const shutdown = () => {
    logger.info('shutting down labeler service...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
