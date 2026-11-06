import test from 'node:test';
import assert from 'node:assert/strict';
import { canStampPermanentMiss } from './description-backfill';

// The rule the stamp hangs on. A 429 recorded mid-call leaves the consecutive
// breaker count unchanged on the next successful reset, so only the lifetime
// delta can tell "asked and nothing found" from "could not ask".

test('upstream answered and nothing was found: the miss is permanent', () => {
  assert.equal(canStampPermanentMiss(0, 0, false), true);
});

test('a failure recorded during the call defers the stamp', () => {
  assert.equal(canStampPermanentMiss(4, 5, false), false);
});

test('a breaker already open before the call defers the stamp', () => {
  assert.equal(canStampPermanentMiss(0, 0, true), false);
});
