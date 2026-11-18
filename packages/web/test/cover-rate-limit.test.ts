/**
 * The cover rate limiter: a deliberate, tiny token bucket. The clock is
 * injected, so these assertions are about arithmetic, not timing.
 */

import { expect, test } from 'vitest';

import { createTokenBucket } from '../src/lib/server/covers/rate-limit.ts';

test('a bucket allows its capacity, then answers with a retry delay', () => {
  let now = 0;
  const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 1, now: () => now });

  expect(bucket.take('ip')).toEqual({ allowed: true, retryAfterSeconds: 0 });
  expect(bucket.take('ip')).toEqual({ allowed: true, retryAfterSeconds: 0 });
  expect(bucket.take('ip')).toEqual({ allowed: true, retryAfterSeconds: 0 });
  expect(bucket.take('ip')).toEqual({ allowed: false, retryAfterSeconds: 1 });

  now += 1000;
  expect(bucket.take('ip')).toEqual({ allowed: true, retryAfterSeconds: 0 });
});

test('keys are independent, so one client cannot spend another allowance', () => {
  const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, now: () => 0 });

  expect(bucket.take('a').allowed).toBe(true);
  expect(bucket.take('a').allowed).toBe(false);
  expect(bucket.take('b').allowed).toBe(true);
});

test('refill never exceeds the burst', () => {
  let now = 0;
  const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 1, now: () => now });
  bucket.take('ip');
  bucket.take('ip');

  now += 60_000;
  expect(bucket.take('ip').allowed).toBe(true);
  expect(bucket.take('ip').allowed).toBe(true);
  expect(bucket.take('ip').allowed, 'a full minute is not an infinite burst').toBe(false);
});

test('the retry delay rounds up to a whole second, minimum one', () => {
  let now = 0;
  const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, now: () => now });
  bucket.take('ip');

  now += 500;
  const denied = bucket.take('ip');
  expect(denied.allowed).toBe(false);
  expect(denied.retryAfterSeconds, 'half a token left is half a second, rounded up').toBe(1);
});

test('the map stays bounded under a scan from many addresses', () => {
  const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, maxKeys: 4, now: () => 0 });

  for (let index = 0; index < 50; index += 1) bucket.take(`ip-${index}`);

  // The oldest entries were evicted, so an early key is new again rather than
  // remembered forever.
  expect(bucket.take('ip-0').allowed).toBe(true);
  expect(bucket.take('ip-49').allowed, 'the recent key kept its spent token').toBe(false);
});
