/**
 * `giveaway_terms`: the closing date the AppView verified, and the procedure
 * that is allowed to move it.
 *
 * The property under test is that a record cannot end a giveaway early. The
 * record is in its author's repo, so `com.atproto.repo.putRecord` can rewrite
 * `closesAt` with no app involved; the stored term is what the draw obeys, and a
 * record that disagrees is refused with both dates named, so the caller can
 * rewrite it back.
 *
 * The service token is a real JWT signed by a real key and verified against a
 * DID document served by a stubbed `fetch`, as in `giveaway-draw.test.ts`.
 */

import { afterAll, beforeAll, expect, test, vi } from 'vitest';

import { Secp256k1Keypair } from '@atproto/crypto';
import pg from 'pg';

import { GIVEAWAY_EVENT_COLLECTION } from '../src/lib/server/catalog/giveaway.ts';
import { giveawayDraw } from '../src/lib/server/catalog/giveaway-draw-handler.ts';
import {
  giveawayExtend,
  giveawayExtendAudience,
  type GiveawayExtendContext
} from '../src/lib/server/catalog/giveaway-extend-handler.ts';
import {
  authorizeExtension,
  GIVEAWAY_TERMS_TABLE,
  verifyGiveawayTerm
} from '../src/lib/server/catalog/giveaway-terms.ts';
import { GIVEAWAY_EXTEND } from '../src/lib/server/catalog/entity-methods.ts';

const AUTHOR_DID = 'did:web:termsauthor.test';
const STRANGER_DID = 'did:web:termsstranger.test';
const RUN = `${process.pid}-${Date.now()}`;
const EDITION = `at://did:plc:catalogue/community.lexicon.media.book.edition/terms${RUN}`;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

type Keypair = { did(): string; sign(message: Uint8Array): Promise<Uint8Array> };
const keypairs = new Map<string, Keypair>();

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

async function mint(keypair: Keypair, iss: string, lxm: string): Promise<string> {
  const header = { alg: 'ES256K', typ: 'JWT' };
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    iss,
    aud: giveawayExtendAudience(),
    lxm,
    iat: issuedAt,
    exp: issuedAt + 55
  };
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await keypair.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

let pool: pg.Pool | undefined;
let context: GiveawayExtendContext | undefined;

function requiredContext(t: { skip: (message?: string) => void }): {
  pool: pg.Pool;
  context: GiveawayExtendContext;
} | null {
  if (!pool || !context) {
    t.skip('DATABASE_URL is not reachable; skipping giveaway term integration tests');
    return null;
  }
  return { pool, context };
}

function eventRecord(closesAt: string): string {
  return JSON.stringify({
    $type: GIVEAWAY_EVENT_COLLECTION,
    edition: EDITION,
    title: `Terms probe ${RUN}`,
    prizeType: 'print',
    prizeQuantity: 1,
    countries: ['*'],
    rulesText: 'One entry per reader.',
    opensAt: new Date(NOW - 6 * HOUR).toISOString(),
    closesAt,
    createdAt: new Date(NOW - 6 * HOUR).toISOString()
  });
}

/** A giveaway in the index under a fresh rkey, closing at `closesAt`. */
async function seedGiveaway(db: pg.Pool, rkey: string, closesAt: string): Promise<string> {
  const uri = `at://${AUTHOR_DID}/${GIVEAWAY_EVENT_COLLECTION}/${rkey}-${RUN}`;
  await db.query(
    `INSERT INTO happyview.happyview_records
       (uri, did, collection, rkey, record, cid, indexed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [uri, AUTHOR_DID, GIVEAWAY_EVENT_COLLECTION, `${rkey}-${RUN}`, eventRecord(closesAt), `cid${rkey}`, new Date(NOW - 6 * HOUR).toISOString()]
  );
  return uri;
}

/** Rewrite a seeded record's term, as `putRecord` would: the record, not the row. */
async function rewriteRecord(db: pg.Pool, uri: string, closesAt: string): Promise<void> {
  await db.query(
    `UPDATE happyview.happyview_records
        SET record = $2, cid = $3
      WHERE uri = $1`,
    [uri, eventRecord(closesAt), `cid-rewritten-${Date.now()}`]
  );
}

beforeAll(async () => {
  for (const did of [AUTHOR_DID, STRANGER_DID]) {
    keypairs.set(did, await Secp256k1Keypair.create());
  }
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const did = `did:web:${new URL(url).hostname}`;
    const keypair = keypairs.get(did);
    if (!url.endsWith('/.well-known/did.json') || keypair === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(documentFor(did, keypair)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

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
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!pool) return;
  await pool.query(`DELETE FROM ${GIVEAWAY_TERMS_TABLE} WHERE giveaway LIKE $1`, [`%${RUN}%`]);
  await pool.query('DELETE FROM giveaway_draws WHERE giveaway LIKE $1', [`%${RUN}%`]);
  await pool.query(`DELETE FROM happyview.happyview_records WHERE uri LIKE '%${RUN}%'`);
  await pool.end();
  pool = undefined;
  context = undefined;
});

test('the first sighting pins the term and the CID that stated it', async (t) => {
  const ready = requiredContext(t);
  if (!ready) return;

  const closesAt = new Date(NOW + 48 * HOUR).toISOString();
  const uri = await seedGiveaway(ready.pool, 'pin', closesAt);

  const verdict = await verifyGiveawayTerm(ready.pool, uri);
  expect(verdict).toMatchObject({ ok: true, closesAt });

  const stored = await ready.pool.query(
    `SELECT closes_at, cid FROM ${GIVEAWAY_TERMS_TABLE} WHERE giveaway = $1`,
    [uri]
  );
  expect(stored.rows).toHaveLength(1);
  expect(new Date(stored.rows[0].closes_at as string).toISOString()).toBe(closesAt);
  expect(stored.rows[0].cid).toMatch(/^cid/);
});

test('a rewrite that leaves the term alone is not a discrepancy', async (t) => {
  const ready = requiredContext(t);
  if (!ready) return;

  const closesAt = new Date(NOW + 48 * HOUR).toISOString();
  const uri = await seedGiveaway(ready.pool, 'same-term', closesAt);
  await verifyGiveawayTerm(ready.pool, uri);
  await rewriteRecord(ready.pool, uri, closesAt);

  expect(await verifyGiveawayTerm(ready.pool, uri)).toMatchObject({ ok: true, closesAt });
});

test('a record that ends early is a discrepancy, naming both dates', async (t) => {
  const ready = requiredContext(t);
  if (!ready) return;

  const verified = new Date(NOW + 48 * HOUR).toISOString();
  const tampered = new Date(NOW - HOUR).toISOString();
  const uri = await seedGiveaway(ready.pool, 'shortened', verified);
  await verifyGiveawayTerm(ready.pool, uri);
  await rewriteRecord(ready.pool, uri, tampered);

  const verdict = await verifyGiveawayTerm(ready.pool, uri);
  expect(verdict).toEqual({
    ok: false,
    reason: 'mismatch',
    relation: 'earlier',
    stored: verified,
    current: tampered
  });
});

test('a record that extends itself is a discrepancy too', async (t) => {
  const ready = requiredContext(t);
  if (!ready) return;

  const verified = new Date(NOW + 48 * HOUR).toISOString();
  const tampered = new Date(NOW + 96 * HOUR).toISOString();
  const uri = await seedGiveaway(ready.pool, 'stretched', verified);
  await verifyGiveawayTerm(ready.pool, uri);
  await rewriteRecord(ready.pool, uri, tampered);

  expect(await verifyGiveawayTerm(ready.pool, uri)).toMatchObject({
    ok: false,
    relation: 'later',
    stored: verified,
    current: tampered
  });
});

test('an unreadable term is never pinned', async (t) => {
  const ready = requiredContext(t);
  if (!ready) return;

  const uri = await seedGiveaway(ready.pool, 'unreadable', 'whenever');
  expect(await verifyGiveawayTerm(ready.pool, uri)).toMatchObject({
    ok: false,
    reason: 'mismatch',
    relation: 'invalid'
  });
  const stored = await ready.pool.query(
    `SELECT 1 FROM ${GIVEAWAY_TERMS_TABLE} WHERE giveaway = $1`,
    [uri]
  );
  expect(stored.rows).toHaveLength(0);
});

test('the extension moves the verified term forwards and refuses everything else', async (t) => {
  const ready = requiredContext(t);
  if (!ready) return;

  const verified = new Date(NOW + 48 * HOUR).toISOString();
  const later = new Date(NOW + 120 * HOUR).toISOString();
  const uri = await seedGiveaway(ready.pool, 'extendable', verified);
  await verifyGiveawayTerm(ready.pool, uri);

  expect(await authorizeExtension(ready.pool, uri, verified)).toEqual({
    ok: false,
    reason: 'earlier'
  });
  expect(
    await authorizeExtension(ready.pool, uri, new Date(NOW + 24 * HOUR).toISOString())
  ).toEqual({ ok: false, reason: 'earlier' });

  expect(await authorizeExtension(ready.pool, uri, later)).toEqual({ ok: true, closesAt: later });
  expect(await verifyGiveawayTerm(ready.pool, uri)).toMatchObject({ ok: false, stored: later });
});

test('the extend procedure is the only thing that may move the term', async (t) => {
  const ready = requiredContext(t);
  if (!ready) return;

  const verified = new Date(NOW + 48 * HOUR).toISOString();
  const later = new Date(NOW + 120 * HOUR).toISOString();
  const uri = await seedGiveaway(ready.pool, 'procedure', verified);

  const call = async (body: unknown, token?: string): Promise<Response> =>
    giveawayExtend(
      new Request(`https://biblio.livtet.olamaelcu.net/xrpc/${GIVEAWAY_EXTEND}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
        },
        body: JSON.stringify(body)
      }),
      ready.context
    );

  // No token, then a token minted for a stranger: neither learns anything else.
  expect((await call({ giveaway: uri, closesAt: later })).status).toBe(401);
  const stranger = await mint(keypairs.get(STRANGER_DID)!, STRANGER_DID, GIVEAWAY_EXTEND);
  expect((await call({ giveaway: uri, closesAt: later }, stranger)).status).toBe(403);

  const author = await mint(keypairs.get(AUTHOR_DID)!, AUTHOR_DID, GIVEAWAY_EXTEND);
  const extended = await call({ giveaway: uri, closesAt: later }, author);
  expect(extended.status).toBe(200);
  expect(await extended.json()).toEqual({ giveaway: uri, closesAt: later });
  // The AppView has moved and the record has not: writing the answered date into
  // the record is the caller's half of the contract, and until it does, the
  // record is the discrepancy — not the row.
  expect(await verifyGiveawayTerm(ready.pool, uri)).toMatchObject({
    ok: false,
    relation: 'earlier',
    stored: later,
    current: verified
  });
  await rewriteRecord(ready.pool, uri, later);
  expect(await verifyGiveawayTerm(ready.pool, uri)).toMatchObject({ ok: true, closesAt: later });

  // Backwards is refused, and the refusal names the verified date.
  const earlier = new Date(NOW + 24 * HOUR).toISOString();
  const refused = await call({ giveaway: uri, closesAt: earlier }, author);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: 'NotLater', stored: later });
});

test('the draw refuses a tampered record instead of concluding early', async (t) => {
  const ready = requiredContext(t);
  if (!ready) return;

  // Open for two more days: a draw would be refused as NotClosed…
  const verified = new Date(NOW + 48 * HOUR).toISOString();
  const uri = await seedGiveaway(ready.pool, 'tampered', verified);
  const token = await mint(keypairs.get(AUTHOR_DID)!, AUTHOR_DID, 'net.olamaelcu.livtet.biblio.giveaway.draw');
  const draw = async (): Promise<Response> =>
    giveawayDraw(
      new Request('https://biblio.livtet.olamaelcu.net/xrpc/net.olamaelcu.livtet.biblio.giveaway.draw', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ giveaway: uri })
      }),
      ready.context
    );

  expect((await draw()).status).toBe(409);

  // …until the record is rewritten to end it now. That must not buy a draw.
  await rewriteRecord(ready.pool, uri, new Date(NOW - HOUR).toISOString());
  const tampered = await draw();
  expect(tampered.status).toBe(409);
  expect(await tampered.json()).toMatchObject({
    error: 'TermMismatch',
    stored: verified,
    relation: 'earlier'
  });

  const drawn = await ready.pool.query('SELECT 1 FROM giveaway_draws WHERE giveaway = $1', [uri]);
  expect(drawn.rows).toHaveLength(0);

  // Restored to the verified term, the giveaway is open again — and still not
  // drawable, because its verified end has not passed.
  await rewriteRecord(ready.pool, uri, verified);
  expect((await draw()).status).toBe(409);
  const after = await ready.pool.query('SELECT 1 FROM giveaway_draws WHERE giveaway = $1', [uri]);
  expect(after.rows).toHaveLength(0);
});
