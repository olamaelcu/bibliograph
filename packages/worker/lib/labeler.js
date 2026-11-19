/**
 * The labeler endpoint: `com.atproto.label.queryLabels` and
 * `com.atproto.label.subscribeLabels`, served from `labeler_labels`.
 *
 * Both reads are the same table, so the stream is a cursor into the log rather
 * than an in-memory broadcast: a restart, a dropped socket or a slow consumer
 * resumes from its own `seq` and nothing is missed. That is also why the server
 * polls instead of subscribing to an emitter — the table is the pub/sub.
 *
 * The service is internal: it binds loopback and the edge's nginx site proxies
 * the two exact paths to it, with `Upgrade` headers for the subscription.
 */

import { readFile } from 'node:fs/promises';
import http from 'node:http';

import { Secp256k1Keypair, multibaseToBytes } from '@atproto/crypto';
import { WebSocketServer } from 'ws';

import { FutureCursorError, encodeLabel, queryLabels } from './labels.js';

export const DEFAULT_LABELER_HOST = '127.0.0.1';
export const DEFAULT_LABELER_PORT = 9466;
export const QUERY_LABELS = '/xrpc/com.atproto.label.queryLabels';
export const SUBSCRIBE_LABELS = '/xrpc/com.atproto.label.subscribeLabels';
/** Rows per stream frame, and per poll. */
const STREAM_BATCH = 500;
const POLL_INTERVAL_MS = 1000;
const PRIVATE_LINE = 'private=';

/**
 * Read the labeler key from `file`.
 *
 * The file is the output of `scripts/gen-labeler-key.mjs`: comment lines, then
 * `private=<base58btc multibase>`. Only that line is read, so the public half
 * and the did:key in the same file document the key without being trusted.
 */
export async function loadLabelerKeypair(file) {
  const text = await readFile(file, 'utf8');
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(PRIVATE_LINE));
  if (!line) throw new Error(`${file} carries no ${PRIVATE_LINE} line`);
  const multibase = line.slice(PRIVATE_LINE.length).trim();
  if (multibase === '') throw new Error(`${file} has an empty ${PRIVATE_LINE} line`);
  return Secp256k1Keypair.import(multibaseToBytes(multibase));
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function boundedLimit(raw, fallback, max) {
  const parsed = Number(raw ?? '');
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** Every label in `seq` order after `after`, in one page. */
async function labelsAfter(pool, after, limit = STREAM_BATCH) {
  const result = await pool.query(
    `SELECT seq, src, uri, cid, val, neg, cts, exp, sig
       FROM labeler_labels
      WHERE seq > $1
      ORDER BY seq
      LIMIT $2`,
    [after, limit]
  );
  return result.rows;
}

async function maxSeq(pool) {
  const result = await pool.query('SELECT COALESCE(max(seq), 0) AS max FROM labeler_labels');
  return Number(result.rows[0]?.max ?? 0);
}

/**
 * Start the labeler. Returns `{ url, port, close() }`; `close()` ends every open
 * subscription before the listener.
 */
export async function startLabeler({
  pool,
  src,
  host = DEFAULT_LABELER_HOST,
  port = DEFAULT_LABELER_PORT,
  logger = console
}) {
  if (!pool) throw new Error('labeler requires the catalog pool');
  if (typeof src !== 'string' || !src.startsWith('did:')) {
    throw new Error(`labeler src must be a DID, got ${JSON.stringify(src)}`);
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET') {
      json(response, 405, { error: 'MethodNotAllowed' });
      return;
    }
    if (url.pathname === '/health') {
      json(response, 200, { ok: true });
      return;
    }
    if (url.pathname !== QUERY_LABELS) {
      json(response, 404, { error: 'NotFound' });
      return;
    }
    const uriPatterns = url.searchParams.getAll('uriPatterns').filter((value) => value !== '');
    const sources = url.searchParams.getAll('sources').filter((value) => value !== '');
    queryLabels(pool, {
      uriPatterns,
      sources,
      limit: boundedLimit(url.searchParams.get('limit'), 50, 250),
      cursor: url.searchParams.get('cursor') ?? undefined
    }).then(
      (page) => {
        const labels = page.labels.map(encodeLabel);
        json(
          response,
          200,
          page.cursor === undefined ? { labels } : { labels, cursor: page.cursor }
        );
      },
      (error) => {
        if (error instanceof FutureCursorError) {
          json(response, 400, { error: 'FutureCursor', message: error.message });
          return;
        }
        logger.error?.(`labeler: queryLabels failed — ${error?.message ?? error}`);
        json(response, 500, { error: 'InternalServerError' });
      }
    );
  });
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== SUBSCRIBE_LABELS) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void streamLabels(ws, url, pool, logger);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/**
 * One subscription: replay what the cursor missed, then poll for what arrives
 * while the socket is open.
 */
async function streamLabels(ws, url, pool, logger) {
  const requested = url.searchParams.get('cursor');
  let last;
  try {
    const head = await maxSeq(pool);
    if (requested === null || requested === '') {
      // No cursor means "from now on", which is the spec's default.
      last = head;
    } else {
      const parsed = Number(requested);
      if (!Number.isInteger(parsed) || parsed < 0) {
        ws.send(JSON.stringify({ error: 'InvalidRequest', message: 'cursor must be an integer' }));
        ws.close();
        return;
      }
      if (parsed > head) {
        ws.send(JSON.stringify({ error: 'FutureCursor', message: 'cursor is in the future' }));
        ws.close();
        return;
      }
      last = parsed;
    }
  } catch (error) {
    logger.error?.(`labeler: subscribe failed — ${error?.message ?? error}`);
    ws.send(JSON.stringify({ error: 'InternalServerError', message: 'the label stream failed' }));
    ws.close();
    return;
  }

  let timer;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  ws.on('close', stop);
  ws.on('error', stop);

  const pump = async () => {
    if (stopped) return;
    try {
      const rows = await labelsAfter(pool, last);
      if (rows.length > 0) {
        // One frame per contiguous run, so a large backlog is not one huge frame.
        ws.send(
          JSON.stringify({
            seq: Number(rows[rows.length - 1].seq),
            labels: rows.map(encodeLabel)
          })
        );
        last = Number(rows[rows.length - 1].seq);
        // More rows waiting behind this batch: keep going without waiting.
        if (rows.length === STREAM_BATCH) {
          setImmediate(() => void pump());
          return;
        }
      }
    } catch (error) {
      logger.error?.(`labeler: stream poll failed — ${error?.message ?? error}`);
    }
    if (!stopped) timer = setTimeout(() => void pump(), POLL_INTERVAL_MS);
  };

  await pump();
}
