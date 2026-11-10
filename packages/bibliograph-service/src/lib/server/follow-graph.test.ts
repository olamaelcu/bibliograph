import test from 'node:test';
import assert from 'node:assert/strict';
import { didFromFollowSubject, followEdgeFromRecord } from './follow-graph';

const FOLLOWER = 'did:plc:follower';
const FOLLOWED = 'did:plc:followed';

test('a bare at-uri subject yields the followed DID', () => {
  assert.equal(didFromFollowSubject(`at://${FOLLOWED}`), FOLLOWED);
});

test('a deeper at-uri subject yields its authority DID', () => {
  assert.equal(
    didFromFollowSubject(`at://${FOLLOWED}/net.olamaelcu.livtet.biblio.follow/3abc`),
    FOLLOWED,
  );
});

test('a subject that is not an at-uri names no identity', () => {
  assert.equal(didFromFollowSubject(FOLLOWED), null);
  assert.equal(didFromFollowSubject('https://example.com/did:plc:x'), null);
  assert.equal(didFromFollowSubject(undefined), null);
  assert.equal(didFromFollowSubject(42), null);
});

test('an at-uri whose authority is not a DID names no identity', () => {
  assert.equal(didFromFollowSubject('at://biblio.test/some.collection/3abc'), null);
});

test('a follow record becomes the edge it names', () => {
  assert.deepEqual(followEdgeFromRecord(FOLLOWER, { subject: `at://${FOLLOWED}` }), {
    followerDid: FOLLOWER,
    followedDid: FOLLOWED,
  });
});

test('a follow record without a usable subject names no edge', () => {
  assert.equal(followEdgeFromRecord(FOLLOWER, {}), null);
  assert.equal(followEdgeFromRecord(FOLLOWER, { subject: FOLLOWED }), null);
});
