import { afterAll, beforeAll, expect, test } from 'vitest';

import pg from 'pg';
import WebSocket from 'ws';
import { Secp256k1Keypair } from '@atproto/crypto';

import { ensureSupportSchema } from '../lib/setup.js';
import { startLabeler } from '../lib/labeler.js';
import { LABEL_VALUE_KNOWN_AUTHOR, signLabel } from '../lib/labels.js';

/**
 * The labeler as a consumer sees it: two `com.atproto.label` endpoints over
 * HTTP, served from `labeler_labels`.
 *
 * The service is a plain `node:http` listener plus a WebSocket upgrade, so it is
 * started here on an ephemeral port against the same scratch database the other
 * worker suites use. That is the only tier that exercises the wire format — the
 * `{ "$bytes" }` signature encoding, the `no-store` header, cursor paging, the
 * negation rule, and the subscription's replay-then-poll behaviour.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const SRC = 'did:web:labeler.test';
/** Every row this suite creates starts here, so a neighbour's rows cannot leak in. */
const PREFIX = 'did:plc:labelshttp';
/** Always beyond any sequence this run can reach. */
const FAR_FUTURE = 1_000_000_000;

let pool;
let keypair;
let labeler;
let seq;

/** One signed row, inserted the way `emitLabels` would have stored it. */
async function insertLabel({ uri, val = LABEL_VALUE_KNOWN_AUTHOR, neg = false, src = SRC }) {
  const label = await signLabel(keypair, {
    src,
    uri,
    val,
    cts: new Date(Date.now() + seq).toISOString(),
    neg
  });
  seq += 1;
  const inserted = await pool.query(
    `INSERT INTO labeler_labels (src, uri, val, neg, cts, sig)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING seq`,
    [label.src, label.uri, label.val, label.neg === true, label.cts, Buffer.from(label.sig)]
  );
  return Number(inserted.rows[0].seq);
}

function url(path) {
  return `${labeler.url}${path}`;
}

async function getJson(path) {
  const response = await fetch(url(path));
  const body = await response.json();
  return { status: response.status, headers: response.headers, body };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  await ensureSupportSchema(pool);
  await pool.query('DELETE FROM labeler_labels WHERE uri LIKE $1', [`${PREFIX}%`]);
  const head = await pool.query('SELECT COALESCE(max(seq), 0) AS max FROM labeler_labels');
  seq = Number(head.rows[0].max) + 1;

  keypair = await Secp256k1Keypair.create({ exportable: true });
  labeler = await startLabeler({ pool, src: SRC, port: 0, logger: { error() {} } });
});

afterAll(async () => {
  await labeler?.close();
  if (pool) {
    await pool.query('DELETE FROM labeler_labels WHERE uri LIKE $1', [`${PREFIX}%`]);
    await pool.end();
  }
});

test('the listener answers on a loopback port it chose', () => {
  expect(labeler.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(labeler.port).toBeGreaterThan(0);
});

test('health is a bare ok, and an unknown path is a 404', async () => {
  const health = await getJson('/health');
  expect(health.status).toBe(200);
  expect(health.body).toEqual({ ok: true });

  const missing = await getJson('/xrpc/com.atproto.label.somethingElse');
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ error: 'NotFound' });
});

test('queryLabels answers the defs#label shape a consumer parses', async () => {
  const uri = `${PREFIX}.shape`;
  await insertLabel({ uri });

  const { status, headers, body } = await getJson(
    `/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(uri)}`
  );
  expect(status).toBe(200);
  expect(headers.get('cache-control')).toBe('no-store');

  const [label] = body.labels;
  expect(label.ver).toBe(1);
  expect(label.src).toBe(SRC);
  expect(label.uri).toBe(uri);
  expect(label.val).toBe(LABEL_VALUE_KNOWN_AUTHOR);
  expect(label.neg).toBeUndefined();
  // The lexicon types `sig` as `bytes`, which JSON can only carry this way.
  expect(typeof label.sig.$bytes).toBe('string');
  expect(Buffer.from(label.sig.$bytes, 'base64').length).toBe(64);
  // No cursor: the page was not full.
  expect(Object.hasOwn(body, 'cursor')).toBe(false);
});

test('a prefix pattern matches every account under it, and sources filter the labeler', async () => {
  const a = `${PREFIX}.prefixa`;
  const b = `${PREFIX}.prefixb`;
  await insertLabel({ uri: a });
  await insertLabel({ uri: b });
  await insertLabel({ uri: `${PREFIX}.foreign`, src: 'did:web:other.labeler' });

  const byPrefix = await getJson(
    `/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(`${PREFIX}.prefix*`)}`
  );
  expect(byPrefix.body.labels.map((label) => label.uri).sort()).toEqual([a, b]);

  const bySource = await getJson(
    `/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(
      `${PREFIX}.*`
    )}&sources=${encodeURIComponent(SRC)}`
  );
  expect(bySource.body.labels.every((label) => label.src === SRC)).toBe(true);
  expect(bySource.body.labels.map((label) => label.uri)).not.toContain(`${PREFIX}.foreign`);
});

test('limit and cursor page the stream, and the cursor is the last seq served', async () => {
  const uris = [`${PREFIX}.page1`, `${PREFIX}.page2`, `${PREFIX}.page3`];
  for (const uri of uris) await insertLabel({ uri });

  const pattern = encodeURIComponent(`${PREFIX}.page*`);
  const first = await getJson(`/xrpc/com.atproto.label.queryLabels?uriPatterns=${pattern}&limit=2`);
  expect(first.body.labels.map((label) => label.uri)).toEqual(uris.slice(0, 2));
  expect(typeof first.body.cursor).toBe('string');

  const second = await getJson(
    `/xrpc/com.atproto.label.queryLabels?uriPatterns=${pattern}&limit=2&cursor=${first.body.cursor}`
  );
  expect(second.body.labels.map((label) => label.uri)).toEqual([uris[2]]);
});

test('a cursor in the future is refused rather than answered empty', async () => {
  const { status, body } = await getJson(
    `/xrpc/com.atproto.label.queryLabels?cursor=${FAR_FUTURE}`
  );
  expect(status).toBe(400);
  expect(body.error).toBe('FutureCursor');
});

test('a negated label is served in the stream but never hydrated by queryLabels', async () => {
  const uri = `${PREFIX}.negated`;
  await insertLabel({ uri });
  expect(
    (await getJson(`/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(uri)}`))
      .body.labels.length
  ).toBe(1);

  await insertLabel({ uri, neg: true });

  const after = await getJson(
    `/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(uri)}`
  );
  expect(after.body.labels).toEqual([]);

  // Both rows are still in the log: the negation is an event, not a delete.
  const stored = await pool.query('SELECT neg FROM labeler_labels WHERE uri = $1 ORDER BY seq', [uri]);
  expect(stored.rows).toEqual([{ neg: false }, { neg: true }]);
});

/** Collect frames until `done` is satisfied, or fail after `budgetMs`. */
function collectFrames(socket, { done, budgetMs = 5_000 }) {
  const frames = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out after ${budgetMs}ms with ${frames.length} frame(s)`));
    }, budgetMs);
    const finish = () => {
      clearTimeout(timer);
      resolve(frames);
    };
    socket.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()));
      if (done(frames)) finish();
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(frames);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function subscribe(cursor) {
  const target = `${labeler.url.replace('http://', 'ws://')}/xrpc/com.atproto.label.subscribeLabels${
    cursor === undefined ? '' : `?cursor=${cursor}`
  }`;
  return new WebSocket(target);
}

test('subscribeLabels replays from the cursor and then streams new labels', async () => {
  const replayUri = `${PREFIX}.replay`;
  const replaySeq = await insertLabel({ uri: replayUri });

  // From just before the row: the subscription must replay it.
  const socket = subscribe(replaySeq - 1);
  const replayed = await collectFrames(socket, {
    done: (frames) => frames.some((frame) => frame.labels?.some((label) => label.uri === replayUri))
  });
  expect(replayed.every((frame) => typeof frame.seq === 'number')).toBe(true);
  const sequence = replayed.map((frame) => frame.seq);
  expect([...sequence].sort((left, right) => left - right)).toEqual(sequence);

  // A row written while the socket is open arrives on its own: the poll is the
  // pub/sub, so nothing about this depends on the writing process.
  const liveUri = `${PREFIX}.live`;
  setTimeout(() => void insertLabel({ uri: liveUri }), 50);
  const live = await collectFrames(socket, {
    done: (frames) => frames.some((frame) => frame.labels?.some((label) => label.uri === liveUri)),
    budgetMs: 8_000
  });
  const streamed = live.flatMap((frame) => frame.labels ?? []).find((label) => label.uri === liveUri);
  expect(streamed.val).toBe(LABEL_VALUE_KNOWN_AUTHOR);
  expect(streamed.sig.$bytes).toBeTruthy();
  socket.close();
});

test('subscribeLabels refuses a future cursor with the spec error frame', async () => {
  const socket = subscribe(FAR_FUTURE);
  const frames = await collectFrames(socket, { done: (received) => received.length > 0 });
  expect(frames[0]).toMatchObject({ error: 'FutureCursor' });
});
