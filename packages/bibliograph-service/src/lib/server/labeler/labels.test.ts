import test from 'node:test';
import assert from 'node:assert/strict';
import { cborEncode } from '@atproto/lex-cbor';
import type { LexValue } from '@atproto/lex-cbor';
import { Secp256k1Keypair, sha256, verifySignature } from '@atproto/crypto';
import {
  LABELER_DID,
  labelSigningFields,
  labelToJson,
  signLabelFields,
  type LabelFields,
} from './labels';

// A throwaway key for the signing tests. `getLabelSigningKey` memoizes the
// imported key, so this must be set before the first signing call.
const keypairPromise = Secp256k1Keypair.create({ exportable: true });

test.before(async () => {
  const kp = await keypairPromise;
  process.env.ATP_LABEL_SIGNING_KEY = Buffer.from(await kp.export()).toString('hex');
});

test('signing fields match the protocol schema exactly', () => {
  const cts = new Date('2026-01-02T03:04:05.000Z');
  const fields = labelSigningFields({
    src: 'did:web:labeler.test',
    uri: 'did:plc:subject',
    val: 'librarian',
    cts,
  });

  assert.deepEqual(fields, {
    ver: 1,
    src: 'did:web:labeler.test',
    uri: 'did:plc:subject',
    val: 'librarian',
    cts: '2026-01-02T03:04:05.000Z',
  });
  // `sig` and `$type` must never be part of the signed payload.
  assert.equal('sig' in fields, false);
  assert.equal('$type' in fields, false);
});

test('negation and expiry are only encoded when set', () => {
  const base = { src: 'did:web:labeler.test', uri: 'did:plc:s', val: 'librarian' };
  const plain = labelSigningFields({ ...base, cts: new Date() });
  assert.equal('neg' in plain, false);
  assert.equal('exp' in plain, false);

  const negated = labelSigningFields({
    ...base,
    cts: new Date('2026-01-01T00:00:00.000Z'),
    neg: true,
    exp: new Date('2027-01-01T00:00:00.000Z'),
  });
  assert.equal(negated.neg, true);
  assert.equal(negated.exp, '2027-01-01T00:00:00.000Z');
});

test('a label signature verifies against the label key over the sha256 of the cbor', async () => {
  const kp = await keypairPromise;
  const fields = labelSigningFields({
    src: LABELER_DID,
    uri: 'did:plc:subject',
    val: 'librarian',
    cts: new Date('2026-05-05T00:00:00.000Z'),
  });

  const sig = await signLabelFields(fields);
  const digest = await sha256(cborEncode(fields as unknown as LexValue));

  assert.equal(await verifySignature(kp.did(), digest, sig), true);

  // A tampered field must not verify: this is what stops a relabeled subject.
  const tampered = { ...fields, uri: 'did:plc:someone-else' } as LabelFields;
  const tamperedDigest = await sha256(cborEncode(tampered as unknown as LexValue));
  assert.equal(await verifySignature(kp.did(), tamperedDigest, sig), false);
});

test('the signature is detached from the payload (sig is not hashed over itself)', async () => {
  const kp = await keypairPromise;
  const fields = labelSigningFields({
    src: LABELER_DID,
    uri: 'did:plc:subject',
    val: 'librarian',
    cts: new Date('2026-05-06T00:00:00.000Z'),
  });
  const sig = await signLabelFields(fields);
  // Re-signing the same fields is deterministic for the same key.
  const again = await signLabelFields(fields);
  assert.deepEqual(Buffer.from(again), Buffer.from(sig));
  assert.equal(await verifySignature(kp.did(), await sha256(cborEncode(fields as unknown as LexValue)), sig), true);
});

test('JSON transport carries ver, cts and the signature as $bytes', () => {
  const row = {
    seq: 7,
    src: LABELER_DID,
    uri: 'did:plc:subject',
    val: 'librarian',
    cid: null,
    neg: false,
    cts: new Date('2026-02-02T00:00:00.000Z'),
    exp: null,
    sig: 'c2lnbmF0dXJl',
    createdAt: new Date(),
  };

  assert.deepEqual(labelToJson(row), {
    ver: 1,
    src: LABELER_DID,
    uri: 'did:plc:subject',
    val: 'librarian',
    cts: '2026-02-02T00:00:00.000Z',
    sig: { $bytes: 'c2lnbmF0dXJl' },
  });

  // Negations and expiries surface only when present.
  const negated = labelToJson({ ...row, neg: true, exp: new Date('2027-02-02T00:00:00.000Z') });
  assert.equal(negated.neg, true);
  assert.equal(negated.exp, '2027-02-02T00:00:00.000Z');
});
