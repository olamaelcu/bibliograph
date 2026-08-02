import { ComAtprotoLabelSubscribeLabels, ComAtprotoLabelDefs } from '@atcute/atproto';
import { encode } from '@atcute/cbor';
import { concat } from '@atcute/uint8array';
import type { SubscriptionHandler, SubscriptionContext } from '@atcute/xrpc-server';
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
type Message = Labels | Info;

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
 * The handler is an async generator; the caller encodes each yielded message as a
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

/**
 * Encode a subscription message as a CBOR frame: a header `{op: 1, t: <type>}`
 * followed by the message body with the `$type` field omitted. This matches the
 * `com.atproto.*.subscribe*` framing expected by atproto clients.
 */
export function encodeSubscriptionFrame(message: Message): Uint8Array<ArrayBuffer> {
  const { $type, ...body } = message;
  const type = `#${$type.split('#')[1]}`;
  return concat([encode({ op: 1, t: type }), encode(body)]);
}

/**
 * Hono WebSocket events factory for `com.atproto.label.subscribeLabels`.
 * Each connected client gets its own async generator; messages are encoded to
 * CBOR frames and pushed to the socket. Disconnect aborts the generator.
 */
export function createSubscribeLabelsEvents(
  options: LabelerServiceOptions = {},
): (ctx: { params: Record<string, unknown> }) => {
  onOpen: (evt: Event, ws: { send(data: Uint8Array<ArrayBuffer>): void; close(code?: number, reason?: string): void }) => void;
  onClose: () => void;
  onError: () => void;
} {
  return (ctx) => {
    const controller = new AbortController();
    const cursor = ctx.params.cursor;
    const generator = createSubscribeLabelsHandler(options)({
      params: cursor !== undefined ? { cursor: Number(cursor) } : {},
      signal: controller.signal,
      request: new Request('http://localhost'),
    });
    const iterator = generator[Symbol.asyncIterator]();

    return {
      onOpen(_evt, ws) {
        (async () => {
          for (;;) {
            const { value, done } = await iterator.next();
            if (done || controller.signal.aborted) break;
            ws.send(encodeSubscriptionFrame(value as Message));
          }
        })().catch((err) => {
          logger.error({ err }, 'subscribeLabels stream error');
        });
      },
      onClose() {
        controller.abort();
      },
      onError() {
        controller.abort();
      },
    };
  };
}
