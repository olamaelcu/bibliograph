import { afterAll, beforeAll, expect, test } from 'vitest';

import pg from 'pg';

import { ensureSupportSchema } from '../lib/setup.js';
import { startAdminServer } from '../lib/admin.js';
import { LABEL_VALUE_KNOWN_AUTHOR } from '../lib/labels.js';
import { claimUriFor, ensureHappyviewRecords, indexClaim } from './support/happyview.js';

/**
 * The worker's admin API as the edge sees it: the routes `/librarian` proxies.
 *
 * `admin.test.js` covers provider search and ingest through the same listener;
 * this suite is the claim surface only, over HTTP, with a bearer token. What it
 * pins is the mapping the page depends on: `ClaimError`'s status and code reach
 * the caller unchanged, a refusal writes nothing, and a decision is transcribed
 * into the queues exactly once.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const TOKEN = 'claims-admin-test-token';
const AUTHORITY = 'did:plc:claimsadminauthority';
const LIBRARIAN = 'did:plc:claimsadminlibrarian';
const MARK = 'CLAIMSADMIN';
const DID_APPROVED = 'did:plc:claimsadminapproved';
const DID_LINKED = 'did:plc:claimsadminlinked';
const DID_REJECTED = 'did:plc:claimsadminrejected';

let pool;
let admin;
let contributorUri;

async function cleanup() {
  if (!pool) return;
  const subjects = [DID_APPROVED, DID_LINKED, DID_REJECTED];
  await pool.query('DELETE FROM labeler_labels WHERE uri = ANY($1::text[])', [subjects]);
  await pool.query('DELETE FROM label_outbox WHERE uri = ANY($1::text[])', [subjects]);
  await pool.query('DELETE FROM contributor_claims WHERE subject_did = ANY($1::text[])', [subjects]);
  await pool.query('DELETE FROM contributor_identities WHERE did = ANY($1::text[])', [subjects]);
  await pool.query('DELETE FROM happyview.happyview_records WHERE did = ANY($1::text[])', [subjects]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`at://${AUTHORITY}/%`]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [`at://${AUTHORITY}/%`]);
  await pool.query('DELETE FROM contributors WHERE name LIKE $1', [`${MARK}%`]);
}

function url(path) {
  return `${admin.url}${path}`;
}

/**
 * Every label for one account, queued or already signed.
 *
 * `label_outbox` is a shared queue: another suite running in parallel can drain
 * a row with `emitLabels` between this suite's write and its assertion, which
 * moves it to `labeler_labels`. Reading both is what a consumer sees, so the
 * assertions stay about the label and not about which side of the drain it
 * happened to land on.
 */
async function labelsFor(uri) {
  const queued = await pool.query(
    'SELECT val, neg FROM label_outbox WHERE uri = $1 ORDER BY id',
    [uri]
  );
  const signed = await pool.query(
    'SELECT val, neg FROM labeler_labels WHERE uri = $1 ORDER BY seq',
    [uri]
  );
  return [...queued.rows, ...signed.rows];
}

async function call(path, { method = 'GET', body, token = TOKEN } = {}) {
  const response = await fetch(url(path), {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

function decideBody(did, action, extra = {}) {
  return {
    claimUri: claimUriFor(did),
    subjectDid: did,
    contributorUri,
    action,
    issuedBy: LIBRARIAN,
    ...extra
  };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  await ensureSupportSchema(pool);
  await ensureHappyviewRecords(pool);
  await cleanup();

  const inserted = await pool.query(
    `INSERT INTO contributors (name, at_uri)
     VALUES ($1, 'at://' || $2 || '/net.olamaelcu.livtet.biblio.contributor/' || editions_next_tid())
     RETURNING at_uri`,
    [`${MARK} Author`, AUTHORITY]
  );
  contributorUri = inserted.rows[0].at_uri;
  // The insert queued the contributor's own record; this suite counts queues.
  await pool.query('DELETE FROM pds_outbox WHERE uri = $1', [contributorUri]);

  for (const did of [DID_APPROVED, DID_LINKED, DID_REJECTED]) {
    await indexClaim(pool, did, contributorUri, `claim from ${did}`);
  }

  admin = await startAdminServer({
    pool,
    providers: { providers: {} },
    publisherDid: AUTHORITY,
    publisherHost: 'biblio.test',
    env: { ADMIN_TOKEN: TOKEN, WORKER_ADMIN_PORT: '0' },
    logger: { log() {}, warn() {}, error() {} }
  });
});

afterAll(async () => {
  await admin?.close();
  await cleanup();
  await pool?.end();
});

test('the listener binds an ephemeral port and the token is required', async () => {
  expect(admin.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const anonymous = await call('/claims/pending', { token: null });
  expect(anonymous.status).toBe(401);
  expect(anonymous.body.error).toBe('Unauthorized');
});

test('pending claims are served with the contributor resolved', async () => {
  const { status, body } = await call('/claims/pending');
  expect(status).toBe(200);

  const claim = body.items.find((item) => item.did === DID_APPROVED);
  expect(claim).toMatchObject({
    uri: claimUriFor(DID_APPROVED),
    contributorUri,
    name: `${MARK} Author`,
    contributorAtUri: contributorUri,
    message: `claim from ${DID_APPROVED}`
  });
  expect(body.pending).toBe(body.items.length);
});

test('approving writes the binding, the decision, the record and the label', async () => {
  const decided = await call('/claims/decide', {
    method: 'POST',
    body: decideBody(DID_APPROVED, 'approve', { note: 'matches the record' })
  });
  expect(decided.status).toBe(200);
  expect(decided.body).toMatchObject({ state: 'approved', subjectDid: DID_APPROVED });

  const identity = await pool.query(
    'SELECT contributor_id, issued_by FROM contributor_identities WHERE did = $1',
    [DID_APPROVED]
  );
  expect(identity.rowCount).toBe(1);
  expect(identity.rows[0].issued_by).toBe(LIBRARIAN);

  expect(await labelsFor(DID_APPROVED)).toContainEqual({
    val: LABEL_VALUE_KNOWN_AUTHOR,
    neg: false
  });

  const queued = await pool.query(
    `SELECT collection, op FROM pds_outbox
      WHERE uri LIKE $1 AND collection = $2`,
    [`at://${AUTHORITY}/%`, 'net.olamaelcu.livtet.biblio.knownContributor']
  );
  expect(queued.rows).toEqual([
    { collection: 'net.olamaelcu.livtet.biblio.knownContributor', op: 'create' }
  ]);

  // The queue no longer offers it, and the bindings list now does.
  const pending = await call('/claims/pending');
  expect(pending.body.items.some((item) => item.did === DID_APPROVED)).toBe(false);

  const identities = await call('/claims/identities');
  expect(identities.body.items.some((item) => item.did === DID_APPROVED)).toBe(true);
});

test('a second decision about the same claim answers AlreadyDecided and writes nothing', async () => {
  const repeats = await call('/claims/decide', {
    method: 'POST',
    body: decideBody(DID_APPROVED, 'reject')
  });
  expect(repeats.status).toBe(409);
  expect(repeats.body.error).toBe('AlreadyDecided');

  const state = await pool.query(
    'SELECT state FROM contributor_claims WHERE claim_uri = $1',
    [claimUriFor(DID_APPROVED)]
  );
  expect(state.rows).toEqual([{ state: 'approved' }]);
});

test('a contributor that already has an account answers AlreadyLinked', async () => {
  const linked = await call('/claims/decide', {
    method: 'POST',
    body: decideBody(DID_LINKED, 'approve')
  });
  expect(linked.status).toBe(409);
  expect(linked.body.error).toBe('AlreadyLinked');

  // Nothing was written for the refused claim, including its decision.
  expect(
    (await pool.query('SELECT 1 FROM contributor_identities WHERE did = $1', [DID_LINKED])).rowCount
  ).toBe(0);
  expect(
    (await pool.query('SELECT 1 FROM contributor_claims WHERE claim_uri = $1', [claimUriFor(DID_LINKED)]))
      .rowCount
  ).toBe(0);
});

test('rejecting records the outcome and issues no label', async () => {
  const rejected = await call('/claims/decide', {
    method: 'POST',
    body: decideBody(DID_REJECTED, 'reject', { note: 'not the same person' })
  });
  expect(rejected.status).toBe(200);
  expect(rejected.body.state).toBe('rejected');

  expect(
    (await pool.query('SELECT 1 FROM contributor_identities WHERE did = $1', [DID_REJECTED])).rowCount
  ).toBe(0);
  expect(await labelsFor(DID_REJECTED)).toEqual([]);

  const note = await pool.query(
    'SELECT state, note FROM contributor_claims WHERE claim_uri = $1',
    [claimUriFor(DID_REJECTED)]
  );
  expect(note.rows).toEqual([{ state: 'rejected', note: 'not the same person' }]);
});

test('revoking removes the binding and queues the negation', async () => {
  const revoked = await call('/claims/revoke', {
    method: 'POST',
    body: { did: DID_APPROVED, issuedBy: LIBRARIAN }
  });
  expect(revoked.status).toBe(200);
  expect(revoked.body).toMatchObject({ did: DID_APPROVED, contributor: contributorUri });

  expect(
    (await pool.query('SELECT 1 FROM contributor_identities WHERE did = $1', [DID_APPROVED])).rowCount
  ).toBe(0);
  expect(
    (await pool.query('SELECT state FROM contributor_claims WHERE claim_uri = $1', [
      claimUriFor(DID_APPROVED)
    ])).rows
  ).toEqual([{ state: 'revoked' }]);
  // A revocation appends the negation after the approval's positive label: the
  // stream is an event log, and it is the negation that un-hydrates the label.
  expect(await labelsFor(DID_APPROVED)).toContainEqual({
    val: LABEL_VALUE_KNOWN_AUTHOR,
    neg: true
  });
});

test('an unknown account answers NotFound, and a bad body answers InvalidRequest', async () => {
  const unknown = await call('/claims/revoke', {
    method: 'POST',
    body: { did: 'did:plc:claimsadminunknown', issuedBy: LIBRARIAN }
  });
  expect(unknown.status).toBe(404);
  expect(unknown.body.error).toBe('NotFound');

  const malformed = await call('/claims/decide', {
    method: 'POST',
    body: { ...decideBody(DID_LINKED, 'approve'), contributorUri: 'not-an-at-uri' }
  });
  expect(malformed.status).toBe(400);
  expect(malformed.body.error).toBe('InvalidRequest');

  const badAction = await call('/claims/decide', {
    method: 'POST',
    body: decideBody(DID_LINKED, 'maybe')
  });
  expect(badAction.status).toBe(400);
  expect(badAction.body.error).toBe('InvalidRequest');
});

test('the reads are GET-only and every path answers a verdict', async () => {
  const wrongVerb = await call('/claims/decide');
  expect(wrongVerb.status).toBe(405);
  expect(wrongVerb.body.error).toBe('MethodNotAllowed');

  const unknownPath = await call('/claims/nope');
  expect(unknownPath.status).toBe(404);
});
