/**
 * The cover rate limiter: a deliberate, tiny token bucket. The clock is
 * injected, so these assertions are about arithmetic, not timing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTokenBucket } from '../src/lib/server/covers/rate-limit.ts';

test('a bucket allows its capacity, then answers with a retry delay', () => {
  let now = 0;
  const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 1, now: () => now });

  assert.deepEqual(bucket.take('ip'), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(bucket.take('ip'), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(bucket.take('ip'), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(bucket.take('ip'), { allowed: false, retryAfterSeconds: 1 });

  now += 1000;
  assert.deepEqual(bucket.take('ip'), { allowed: true, retryAfterSeconds: 0 });
});

test('keys are independent, so one client cannot spend another allowance', () => {
  const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, now: () => 0 });

  assert.equal(bucket.take('a').allowed, true);
  assert.equal(bucket.take('a').allowed, false);
  assert.equal(bucket.take('b').allowed, true);
});

test('refill never exceeds the burst', () => {
  let now = 0;
  const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 1, now: () => now });
  bucket.take('ip');
  bucket.take('ip');

  now += 60_000;
  assert.equal(bucket.take('ip').allowed, true);
  assert.equal(bucket.take('ip').allowed, true);
  assert.equal(bucket.take('ip').allowed, false, 'a full minute is not an infinite burst');
});

test('the retry delay rounds up to a whole second, minimum one', () => {
  let now = 0;
  const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, now: () => now });
  bucket.take('ip');

  now += 500;
  const denied = bucket.take('ip');
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 1, 'half a token left is half a second, rounded up');
});

test('the map stays bounded under a scan from many addresses', () => {
  const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, maxKeys: 4, now: () => 0 });

  for (let index = 0; index < 50; index += 1) bucket.take(`ip-${index}`);

  // The oldest entries were evicted, so an early key is new again rather than
  // remembered forever.
  assert.equal(bucket.take('ip-0').allowed, true);
  assert.equal(bucket.take('ip-49').allowed, false, 'the recent key kept its spent token');
});
