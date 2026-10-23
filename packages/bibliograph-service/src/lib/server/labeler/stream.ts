// com.atproto.label.subscribeLabels over a raw WebSocket.
//
// This cannot be a SvelteKit route: adapter-node's `build/index.js` creates its
// own http.Server and never exposes the `upgrade` event. `build/handler.js` is
// the supported escape hatch, so `server.ts` owns the server and hands HTTP to
// SvelteKit while keeping upgrades for this module.
//
// Frames are JSON (not CBOR), one per batch:
//   {"$type":"com.atproto.label.subscribeLabels#labels","seq":N,"labels":[...]}
// Backfill starts at `?cursor=` (default 0 = full history, which the spec allows
// for labelers that retain everything) and then follows new rows by polling.
// Polling keeps the implementation dependency-free; LISTEN/NOTIFY would only
// replace the 1s tick with a wakeup.

import type { IncomingMessage, Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { labelToJson, labelsSince, maxSeq } from './labels';

export const SUBSCRIBE_LABELS_PATH = '/xrpc/com.atproto.label.subscribeLabels';

const BACKFILL_BATCH = 100;
const POLL_INTERVAL_MS = 1000;
const LABELS_FRAME = 'com.atproto.label.subscribeLabels#labels';
const INFO_FRAME = 'com.atproto.label.subscribeLabels#info';

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

async function sendLabels(ws: WebSocket, cursor: number): Promise<number> {
  const rows = await labelsSince(cursor, BACKFILL_BATCH);
  if (rows.length === 0) return cursor;
  send(ws, {
    $type: LABELS_FRAME,
    seq: rows[rows.length - 1]!.seq,
    labels: rows.map(labelToJson),
  });
  return rows[rows.length - 1]!.seq;
}

function parseCursor(req: IncomingMessage): number {
  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cursor');
  const parsed = Number(raw ?? '0');
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

async function serveStream(ws: WebSocket, req: IncomingMessage): Promise<void> {
  let closed = false;
  ws.on('close', () => {
    closed = true;
  });
  ws.on('error', () => {
    closed = true;
  });

  let cursor = parseCursor(req);

  try {
    const latest = await maxSeq();
    if (cursor > latest) {
      // The client is ahead of us (bad data, or a reset database).
      send(ws, {
        $type: INFO_FRAME,
        name: 'OutdatedCursor',
        message: `cursor ${cursor} is beyond the latest seq ${latest}`,
      });
      ws.close(1000, 'OutdatedCursor');
      return;
    }

    // Backfill, then follow.
    for (;;) {
      const next = await sendLabels(ws, cursor);
      if (next === cursor) break;
      cursor = next;
      if (closed) return;
    }

    while (!closed) {
      await sleep(POLL_INTERVAL_MS);
      if (closed) return;
      cursor = await sendLabels(ws, cursor);
    }
  } catch (err) {
    if (!closed) ws.close(1011, 'label stream failed');
    throw err;
  }
}

/**
 * Attach the label stream to an existing HTTP server. Any upgrade request for a
 * path this module does not own is rejected, so a misrouted WebSocket fails
 * loudly instead of hanging.
 */
export function attachLabelStream(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== SUBSCRIBE_LABELS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      serveStream(ws, req).catch((err) => {
        console.error('[labeler] stream failed', err);
      });
    });
  });

  return wss;
}
