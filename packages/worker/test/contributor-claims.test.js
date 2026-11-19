import { afterAll, beforeAll, expect, test } from 'vitest';

import pg from 'pg';
import { createHash } from 'node:crypto';

import * as dagCbor from '@ipld/dag-cbor';
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto';

import { ensureSupportSchema } from '../lib/setup.js';
import {
  ClaimError,
  decideClaim,
  listIdentities,
  listPendingClaims,
  revokeIdentity
} from '../lib/claims.js';
import {
  LABEL_VALUE_KNOWN_AUTHOR,
  emitLabels,
  encodeLabel,
  labelPayloadDigest,
  labelSigningPayload,
  queryLabels,
  signLabel
} from '../lib/labels.js';
import { buildKnownContributorRecord } from '../lib/known-contributor-record.js';
import { OUTBOX_COLLECTIONS, claimBatch, prepareEntry } from '../lib/publish.js';
import { claimUriFor, ensureHappyviewRecords, indexClaim } from './support/happyview.js';

/**
 * Contributor claims, the binding they create, and the label the labeler signs.
 *
 * Everything here runs against the configured `DATABASE_URL` (the same database
 * the other worker suites use) and cleans up after itself: the fixtures are
 * prefixed `CLAIMTEST`, and the claim/identity/label rows are deleted by the
 * contributor or DID they name.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const AUTHORITY = 'did:plc:claimtestauthority';
const LIBRARIAN = 'did:plc:claimtestlibrarian';
const MARK = 'CLAIMTEST';
const QUIET = { info() {}, warn() {}, error() {} };

let pool;
let contributorId;
let contributorUri;

async function cleanup() {
  if (!pool) return;
  await pool.query(
    `DELETE FROM labeler_labels WHERE uri = ANY(
       SELECT did FROM contributor_identities WHERE did LIKE 'did:plc:claimtest%'
     )`
  );
  await pool.query(
    `DELETE FROM label_outbox WHERE uri LIKE 'did:plc:claimtest%' OR val = $1`,
    [LABEL_VALUE_KNOWN_AUTHOR]
  );
  await pool.query(
    `DELETE FROM contributor_claims WHERE subject_did LIKE 'did:plc:claimtest%'`
  );
  await pool.query(
    `DELETE FROM contributor_identities WHERE did LIKE 'did:plc:claimtest%'`
  );
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`at://${AUTHORITY}/%`]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [`at://${AUTHORITY}/%`]);
  await pool.query('DELETE FROM contributors WHERE name LIKE $1', [`${MARK}%`]);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  await ensureSupportSchema(pool);
  await ensureHappyviewRecords(pool);
  await cleanup();

  const inserted = await pool.query(
    `INSERT INTO contributors (name, at_uri)
     VALUES ($1, $2)
     RETURNING id, at_uri`,
    [`${MARK} Author`, `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/3claim`]
  );
  contributorId = inserted.rows[0].id;
  contributorUri = inserted.rows[0].at_uri;
  // The insert queued the contributor's own record; the assertions below count
  // outbox rows, so start from a clean slate.
  await pool.query('DELETE FROM pds_outbox WHERE uri = $1', [contributorUri]);
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

test('the published link is built from the binding, and refuses a foreign collection', () => {
  const record = buildKnownContributorRecord({
    did: 'did:plc:claimtestsubject',
    contributor: contributorUri,
    issued_by: LIBRARIAN,
    created_at: new Date('2026-01-02T03:04:05.000Z')
  });
  expect(record).toEqual({
    contributor: contributorUri,
    subject: 'did:plc:claimtestsubject',
    createdAt: '2026-01-02T03:04:05.000Z',
    issuedBy: LIBRARIAN
  });
  // No `$type`: applyWrites receives the collection separately.
  expect(Object.hasOwn(record, '$type')).toBe(false);

  expect(() =>
    buildKnownContributorRecord({
      did: 'did:plc:claimtestsubject',
      contributor: `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.publisher/3pub`,
      created_at: new Date()
    })
  ).toThrow(/contributor/);
});

test('the label payload is canonical DAG-CBOR and the signature verifies', async () => {
  const fields = {
    src: 'did:web:labeler.test',
    uri: 'did:plc:abc',
    val: 'known-author',
    cts: '2026-01-01T00:00:00.000Z'
  };
  const payload = labelSigningPayload(fields);

  // Pinned once, at implementation time: the byte order of the map keys is what
  // a conforming verifier reconstructs, so a change here is a wire change.
  expect(labelPayloadDigest(fields)).toBe(
    '1a00c0059654b137ff7252b1b6f57677a89addba4b30bac6f789919d93b01674'
  );
  expect(dagCbor.decode(payload)).toEqual({ ver: 1, ...fields });
  // Same fields, different insertion order, same bytes.
  expect(
    createHash('sha256')
      .update(labelSigningPayload({ val: 'known-author', ...fields }))
      .digest('hex')
  ).toBe(labelPayloadDigest(fields));

  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const label = await signLabel(keypair, fields);
  expect(label.sig.length).toBe(64);
  expect(await verifySignature(keypair.did(), payload, label.sig)).toBe(true);

  const json = encodeLabel(label);
  expect(json.ver).toBe(1);
  expect(json.src).toBe(fields.src);
  expect(typeof json.sig.$bytes).toBe('string');
  expect(Buffer.from(json.sig.$bytes, 'base64').length).toBe(64);
});

test('a queued label is signed into the stream and leaves the outbox', async () => {
  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const uri = 'did:plc:claimtestlabel';

  await pool.query('INSERT INTO label_outbox (uri, val) VALUES ($1, $2)', [
    uri,
    LABEL_VALUE_KNOWN_AUTHOR
  ]);

  const result = await emitLabels({
    pool,
    keypair,
    src: 'did:web:labeler.test',
    logger: QUIET
  });
  expect(result.emitted).toBeGreaterThanOrEqual(1);
  expect(result.failed).toBe(0);

  const outbox = await pool.query('SELECT 1 FROM label_outbox WHERE uri = $1', [uri]);
  expect(outbox.rowCount).toBe(0);

  const stored = await pool.query(
    'SELECT src, uri, val, neg, sig FROM labeler_labels WHERE uri = $1',
    [uri]
  );
  expect(stored.rowCount).toBe(1);
  expect(stored.rows[0].val).toBe(LABEL_VALUE_KNOWN_AUTHOR);
  expect(stored.rows[0].neg).toBe(false);

  const page = await queryLabels(pool, { uriPatterns: [uri] });
  const label = page.labels.find((row) => row.uri === uri);
  expect(label).toBeDefined();
  expect(
    await verifySignature(keypair.did(), labelSigningPayload(label), label.sig)
  ).toBe(true);
});

test('a negated label is not hydrated, and a future cursor is refused', async () => {
  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const uri = 'did:plc:claimtestnegated';

  await pool.query('INSERT INTO label_outbox (uri, val) VALUES ($1, $2)', [
    uri,
    LABEL_VALUE_KNOWN_AUTHOR
  ]);
  await emitLabels({ pool, keypair, src: 'did:web:labeler.test', logger: QUIET });
  expect((await queryLabels(pool, { uriPatterns: [uri] })).labels.length).toBe(1);

  await pool.query('INSERT INTO label_outbox (uri, val, neg) VALUES ($1, $2, true)', [
    uri,
    LABEL_VALUE_KNOWN_AUTHOR
  ]);
  await emitLabels({ pool, keypair, src: 'did:web:labeler.test', logger: QUIET });

  // The stream carries the negation; the query interface does not hydrate it.
  expect((await queryLabels(pool, { uriPatterns: [uri] })).labels).toEqual([]);

  await expect(queryLabels(pool, { cursor: '99999999' })).rejects.toThrow(/cursor/);
});

test('approving a claim binds the account, publishes the link and queues the label', async () => {
  const subject = 'did:plc:claimtestapprove';
  const claimUri = claimUriFor(subject);
  await indexClaim(pool, subject, contributorUri, 'I am this person.');

  // Before a librarian decides, the queue shows the request with its contributor
  // resolved through the (text) record column.
  const queue = await listPendingClaims(pool);
  const queued = queue.find((row) => row.uri === claimUri);
  expect(queued?.did).toBe(subject);
  expect(queued?.name).toBe(`${MARK} Author`);

  const decided = await decideClaim(pool, {
    claimUri,
    subjectDid: subject,
    contributorUri,
    action: 'approve',
    note: 'matches the catalog record',
    issuedBy: LIBRARIAN,
    authority: AUTHORITY
  });
  expect(decided.state).toBe('approved');

  const identity = await pool.query(
    `SELECT k.did, k.at_uri, k.issued_by, k.contributor_id
       FROM contributor_identities k WHERE k.did = $1`,
    [subject]
  );
  expect(identity.rowCount).toBe(1);
  expect(Number(identity.rows[0].contributor_id)).toBe(Number(contributorId));
  expect(identity.rows[0].issued_by).toBe(LIBRARIAN);
  // The record URI is minted under the publisher authority the worker publishes as.
  expect(identity.rows[0].at_uri.startsWith(`at://${AUTHORITY}/`)).toBe(true);

  const decision = await pool.query(
    'SELECT state, note, decided_by FROM contributor_claims WHERE claim_uri = $1',
    [claimUri]
  );
  expect(decision.rows[0].state).toBe('approved');
  expect(decision.rows[0].decided_by).toBe(LIBRARIAN);

  const label = await pool.query('SELECT val, neg FROM label_outbox WHERE uri = $1', [subject]);
  expect(label.rows).toEqual([{ val: LABEL_VALUE_KNOWN_AUTHOR, neg: false }]);

  // The trigger queued the published record under the new collection.
  const outboxRow = await pool.query(
    'SELECT collection, op FROM pds_outbox WHERE uri = $1',
    [identity.rows[0].at_uri]
  );
  expect(outboxRow.rows).toEqual([
    { collection: 'net.olamaelcu.livtet.biblio.knownContributor', op: 'create' }
  ]);
  expect(OUTBOX_COLLECTIONS).toContain('net.olamaelcu.livtet.biblio.knownContributor');

  const pending = await listPendingClaims(pool);
  expect(pending.some((row) => row.uri === claimUri)).toBe(false);

  const bound = await listIdentities(pool);
  expect(bound.some((row) => row.did === subject && row.contributor === contributorUri)).toBe(true);
});

test('the queued link builds into a knownContributor record', async () => {
  const subject = 'did:plc:claimtestapprove';
  const bound = await pool.query(
    `SELECT k.at_uri FROM contributor_identities k WHERE k.did = $1`,
    [subject]
  );
  const entry = {
    uri: bound.rows[0].at_uri,
    collection: 'net.olamaelcu.livtet.biblio.knownContributor',
    rkey: bound.rows[0].at_uri.split('/')[4],
    op: 'create',
    attempts: 0,
    claimed_at: null,
    updated_at: '2026-01-01 00:00:00+00'
  };
  const prepared = await prepareEntry({ publisherDid: AUTHORITY, pool, entry });
  expect(prepared.operation).toBe('create');
  expect(prepared.value).toMatchObject({
    contributor: contributorUri,
    subject,
    issuedBy: LIBRARIAN
  });
});

test('a second account cannot claim an already-linked contributor', async () => {
  const subject = 'did:plc:claimtestsecond';
  await expect(
    decideClaim(pool, {
      claimUri: claimUriFor(subject),
      subjectDid: subject,
      contributorUri,
      action: 'approve',
      issuedBy: LIBRARIAN,
      authority: AUTHORITY
    })
  ).rejects.toMatchObject({ code: 'AlreadyLinked', status: 409 });

  // Nothing was written by the refused attempt.
  const identity = await pool.query('SELECT 1 FROM contributor_identities WHERE did = $1', [
    subject
  ]);
  expect(identity.rowCount).toBe(0);
  const decision = await pool.query(
    'SELECT 1 FROM contributor_claims WHERE claim_uri = $1',
    [claimUriFor(subject)]
  );
  expect(decision.rowCount).toBe(0);
});

test('one claim is decided once', async () => {
  const subject = 'did:plc:claimtestreject';
  const claimUri = claimUriFor(subject);

  await decideClaim(pool, {
    claimUri,
    subjectDid: subject,
    contributorUri,
    action: 'reject',
    note: 'not the same person',
    issuedBy: LIBRARIAN,
    authority: AUTHORITY
  });

  // A rejection issues no label and no binding.
  expect((await pool.query('SELECT 1 FROM label_outbox WHERE uri = $1', [subject])).rowCount).toBe(
    0
  );

  await expect(
    decideClaim(pool, {
      claimUri,
      subjectDid: subject,
      contributorUri,
      action: 'approve',
      issuedBy: LIBRARIAN,
      authority: AUTHORITY
    })
  ).rejects.toBeInstanceOf(ClaimError);

  const decision = await pool.query(
    'SELECT state FROM contributor_claims WHERE claim_uri = $1',
    [claimUri]
  );
  expect(decision.rows[0].state).toBe('rejected');
});

test('revoking removes the binding, records the outcome and negates the label', async () => {
  const subject = 'did:plc:claimtestapprove';
  const claimUri = claimUriFor(subject);

  // The queue is drained by the suite's own emit tests; clear anything left so
  // the negation asserted below is unambiguous.
  await pool.query('DELETE FROM label_outbox WHERE uri = $1', [subject]);

  const revoked = await revokeIdentity(pool, { did: subject, issuedBy: LIBRARIAN });
  expect(revoked.contributor).toBe(contributorUri);

  expect((await pool.query('SELECT 1 FROM contributor_identities WHERE did = $1', [subject])).rowCount).toBe(0);

  const decision = await pool.query(
    'SELECT state FROM contributor_claims WHERE claim_uri = $1',
    [claimUri]
  );
  expect(decision.rows[0].state).toBe('revoked');

  const label = await pool.query('SELECT val, neg FROM label_outbox WHERE uri = $1', [subject]);
  expect(label.rows).toEqual([{ val: LABEL_VALUE_KNOWN_AUTHOR, neg: true }]);

  // The binding's record delete is queued by the same trigger.
  const removals = await pool.query(
    `SELECT op FROM pds_outbox
      WHERE uri LIKE $1 AND collection = 'net.olamaelcu.livtet.biblio.knownContributor'`,
    [`at://${AUTHORITY}/%`]
  );
  expect(removals.rows.some((row) => row.op === 'delete')).toBe(true);

  await expect(
    revokeIdentity(pool, { did: 'did:plc:claimtestunknown', issuedBy: LIBRARIAN })
  ).rejects.toMatchObject({ code: 'NotFound', status: 404 });
});

test('claimBatch drains the knownContributor collection', async () => {
  const batch = await claimBatch(pool, { publisherDid: AUTHORITY, limit: 50 });
  for (const row of batch) {
    expect(OUTBOX_COLLECTIONS).toContain(row.collection);
  }
});
