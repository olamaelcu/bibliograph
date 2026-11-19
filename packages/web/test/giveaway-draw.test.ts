/**
 * `giveaway.draw`: the winner selection, the stored draw, and the request that
 * decides who may ask for one.
 *
 * Three things must hold and each has its own section below: the selection is a
 * pure function of `(entrants, seed, quantity)`; the stored draw is answered
 * unchanged on every later call (idempotency by insert, not by determinism); and
 * the procedure refuses a caller who is not the record's author, before it writes
 * anything.
 *
 * The service token is a real JWT signed by a real key, and the issuer's DID
 * document is served by a stubbed `fetch` — so the signature path is exercised,
 * not mocked away.
 */

import { afterAll, beforeAll, expect, test, vi } from 'vitest';

import { Secp256k1Keypair } from '@atproto/crypto';
import pg from 'pg';

import { drawWinners } from '../src/lib/server/catalog/giveaway-draw.ts';
import { GIVEAWAY_EVENT_COLLECTION } from '../src/lib/server/catalog/giveaway.ts';
import {
  giveawayDraw,
  giveawayDrawAudience,
  type GiveawayDrawContext
} from '../src/lib/server/catalog/giveaway-draw-handler.ts';
import { GIVEAWAY_DRAW } from '../src/lib/server/catalog/entity-methods.ts';

const AUTHOR_DID = 'did:web:giveawayauthor.test';
const STRANGER_DID = 'did:web:giveawaystranger.test';
const RUN = `${process.pid}-${Date.now()}`;
const EDITION = `at://did:plc:catalogue/community.lexicon.media.book.edition/draw${RUN}`;
const CLOSED_URI = `at://${AUTHOR_DID}/${GIVEAWAY_EVENT_COLLECTION}/closed${RUN}`;
const OPEN_URI = `at://${AUTHOR_DID}/${GIVEAWAY_EVENT_COLLECTION}/open${RUN}`;
const EVENT_CID = 'bafyreidraweventcid';
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const URL_UNDER_TEST = `https://biblio.livtet.olamaelcu.net/xrpc/${GIVEAWAY_DRAW}`;

type Keypair = { did(): string; sign(message: Uint8Array): Promise<Uint8Array> };

function documentFor(did: string, keypair: Keypair): unknown {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: keypair.did().slice('did:key:'.length)
      }
    ]
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

async function mint(
  keypair: Keypair,
  options: { iss: string; aud?: string; lxm?: string }
): Promise<string> {
  const header = { alg: 'ES256K', typ: 'JWT' };
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    iss: options.iss,
    aud: options.aud ?? giveawayDrawAudience(),
    lxm: options.lxm ?? GIVEAWAY_DRAW,
    iat: issuedAt,
    exp: issuedAt + 55
  };
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await keypair.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

function drawRequest(giveaway: string, token?: string): Request {
  return new Request(URL_UNDER_TEST, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    body: JSON.stringify({ giveaway })
  });
}

let pool: pg.Pool | undefined;
let context: GiveawayDrawContext | undefined;
const keypairs = new Map<string, Keypair>();

function requiredContext(t: { skip: (message?: string) => void }): GiveawayDrawContext | null {
  if (!context) {
    t.skip('DATABASE_URL is not reachable; skipping giveaway draw integration tests');
    return null;
  }
  return context;
}

function eventRecord(uri: string, closesAt: string, createdAt: string): string {
  return JSON.stringify({
    $type: GIVEAWAY_EVENT_COLLECTION,
    edition: EDITION,
    title: `Draw probe ${RUN}`,
    prizeType: 'print',
    prizeQuantity: 2,
    countries: ['*'],
    rulesText: 'One entry per reader.',
    opensAt: new Date(NOW - 6 * HOUR).toISOString(),
    closesAt,
    createdAt
  });
}

async function insertRow(
  db: pg.Pool,
  row: { uri: string; did: string; collection: string; record: string; createdAt: string }
): Promise<void> {
  await db.query(
    `INSERT INTO happyview.happyview_records
       (uri, did, collection, rkey, record, cid, indexed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      row.uri,
      row.did,
      row.collection,
      row.uri.slice(row.uri.lastIndexOf('/') + 1),
      row.record,
      `cid${row.uri.slice(-8)}`,
      row.createdAt
    ]
  );
}

const ENTRANTS = ['did:plc:drawentrant-a', 'did:plc:drawentrant-b', 'did:plc:drawentrant-c'];

beforeAll(async () => {
  // Both issuers publish a document; `fetch` answers it, so the verifier runs its
  // real signature and Multikey checks without touching the network.
  for (const did of [AUTHOR_DID, STRANGER_DID]) {
    keypairs.set(did, await Secp256k1Keypair.create());
  }
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const host = new URL(url).hostname;
      const did = `did:web:${host}`;
      const keypair = keypairs.get(did);
      if (!url.endsWith('/.well-known/did.json') || keypair === undefined) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify(documentFor(did, keypair)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  );

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') return;
  const candidate = new pg.Pool({ connectionString });
  try {
    await candidate.query('SELECT 1');
  } catch {
    await candidate.end();
    return;
  }
  pool = candidate;
  context = { plcUrl: 'https://plc.test', pool: candidate };

  await insertRow(candidate, {
    uri: CLOSED_URI,
    did: AUTHOR_DID,
    collection: GIVEAWAY_EVENT_COLLECTION,
    record: eventRecord(
      CLOSED_URI,
      new Date(NOW - HOUR).toISOString(),
      new Date(NOW - 3 * HOUR).toISOString()
    ),
    createdAt: new Date(NOW - 3 * HOUR).toISOString()
  });
  await insertRow(candidate, {
    uri: OPEN_URI,
    did: AUTHOR_DID,
    collection: GIVEAWAY_EVENT_COLLECTION,
    record: eventRecord(
      OPEN_URI,
      new Date(NOW + HOUR).toISOString(),
      new Date(NOW - 2 * HOUR).toISOString()
    ),
    createdAt: new Date(NOW - 2 * HOUR).toISOString()
  });

  for (const [index, did] of ENTRANTS.entries()) {
    const enteredAt = new Date(NOW - (3 - index) * HOUR).toISOString();
    await insertRow(candidate, {
      uri: `at://${did}/net.olamaelcu.livtet.biblio.giveaway.entry/e${RUN}-${index}`,
      did,
      collection: 'net.olamaelcu.livtet.biblio.giveaway.entry',
      record: JSON.stringify({
        $type: 'net.olamaelcu.livtet.biblio.giveaway.entry',
        giveaway: { uri: CLOSED_URI, cid: EVENT_CID },
        createdAt: enteredAt
      }),
      createdAt: enteredAt
    });
  }
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!pool) return;
  await pool.query('DELETE FROM giveaway_draws WHERE giveaway LIKE $1', [`%${RUN}%`]);
  await pool.query(`DELETE FROM happyview.happyview_records WHERE uri LIKE '%${RUN}%'`);
  await pool.end();
  pool = undefined;
  context = undefined;
});

const POOL_IDS = Array.from({ length: 100 }, (_, index) => `did:plc:pool${index}`);

test('the same seed draws the same distinct winners', () => {
  const first = drawWinners(POOL_IDS, 'deadbeef', 3);
  const second = drawWinners(POOL_IDS, 'deadbeef', 3);
  expect(first).toEqual(second);
  expect(new Set(first).size).toBe(3);
  for (const winner of first) expect(POOL_IDS).toContain(winner);
});

test('a different seed draws a different set', () => {
  expect(drawWinners(POOL_IDS, 'deadbeef', 3)).not.toEqual(
    drawWinners(POOL_IDS, 'cafebabe', 3)
  );
});

test('asking for at least as many as there are returns them all', () => {
  expect(drawWinners(['did:plc:a', 'did:plc:b'], 'seed', 5)).toEqual(['did:plc:a', 'did:plc:b']);
});

test('a duplicate entrant counts once and cannot win twice', () => {
  const winners = drawWinners(['did:plc:a', 'did:plc:a', 'did:plc:b'], 'seed', 2);
  expect(new Set(winners).size).toBe(2);
});

test('no entrants draws nobody', () => {
  expect(drawWinners([], 'seed', 3)).toEqual([]);
});

test('a request without a token is refused before anything is read', async (t) => {
  const drawContext = requiredContext(t);
  if (!drawContext) return;

  const response = await giveawayDraw(drawRequest(CLOSED_URI), drawContext);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: 'AuthRequired' });
});

test('a token minted for another audience or method is refused', async (t) => {
  const drawContext = requiredContext(t);
  if (!drawContext) return;
  const keypair = keypairs.get(AUTHOR_DID)!;

  const wrongAudience = await mint(keypair, {
    iss: AUTHOR_DID,
    aud: `${AUTHOR_DID}#atproto_feed`
  });
  const wrongMethod = await mint(keypair, {
    iss: AUTHOR_DID,
    lxm: 'com.atproto.feed.getFeedSkeleton'
  });
  for (const token of [wrongAudience, wrongMethod]) {
    const response = await giveawayDraw(drawRequest(CLOSED_URI, token), drawContext);
    expect(response.status).toBe(401);
  }
});

test('a caller who is not the author is refused and nothing is written', async (t) => {
  const drawContext = requiredContext(t);
  if (!drawContext) return;

  const token = await mint(keypairs.get(STRANGER_DID)!, { iss: STRANGER_DID });
  const response = await giveawayDraw(drawRequest(CLOSED_URI, token), drawContext);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: 'NotAuthor' });

  const rows = await drawContext.pool.query(
    'SELECT count(*)::int AS n FROM giveaway_draws WHERE giveaway = $1',
    [CLOSED_URI]
  );
  expect((rows.rows[0] as { n: number }).n).toBe(0);
});

test('a giveaway that is still open cannot be drawn', async (t) => {
  const drawContext = requiredContext(t);
  if (!drawContext) return;

  const token = await mint(keypairs.get(AUTHOR_DID)!, { iss: AUTHOR_DID });
  const response = await giveawayDraw(drawRequest(OPEN_URI, token), drawContext);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'NotClosed' });

  const rows = await drawContext.pool.query(
    'SELECT count(*)::int AS n FROM giveaway_draws WHERE giveaway = $1',
    [OPEN_URI]
  );
  expect((rows.rows[0] as { n: number }).n).toBe(0);
});

test('the author concludes it once, and every later call answers that draw', async (t) => {
  const drawContext = requiredContext(t);
  if (!drawContext) return;

  const token = await mint(keypairs.get(AUTHOR_DID)!, { iss: AUTHOR_DID });
  const first = await giveawayDraw(drawRequest(CLOSED_URI, token), drawContext);
  expect(first.status).toBe(200);
  const drawn = (await first.json()) as {
    giveaway: string;
    drawnAt: string;
    seed: string;
    entries: number;
    winners: string[];
  };
  expect(drawn.giveaway).toBe(CLOSED_URI);
  expect(drawn.entries).toBe(ENTRANTS.length);
  expect(drawn.winners).toHaveLength(2);
  for (const winner of drawn.winners) expect(ENTRANTS).toContain(winner);
  expect(drawn.winners).toEqual(drawWinners(ENTRANTS, drawn.seed, 2));

  const second = await giveawayDraw(drawRequest(CLOSED_URI, token), drawContext);
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual(drawn);

  const rows = await drawContext.pool.query(
    'SELECT count(*)::int AS n FROM giveaway_draws WHERE giveaway = $1',
    [CLOSED_URI]
  );
  expect((rows.rows[0] as { n: number }).n).toBe(1);
});
