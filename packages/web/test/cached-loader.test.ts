import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';

import { cachedLoader } from '../src/lib/server/cached-loader.ts';

test('reuses a fresh value and reloads once the ttl is past', async () => {
  let clock = 1_000;
  let loads = 0;
  const read = cachedLoader({
    ttlMs: 60_000,
    now: () => clock,
    load: async () => {
      loads += 1;
      return loads;
    }
  });

  assert.equal(await read(), 1);
  assert.equal(loads, 1);
  clock += 59_999;
  assert.equal(await read(), 1);
  assert.equal(loads, 1, 'a value inside the ttl is reused');

  clock += 1;
  assert.equal(await read(), 2);
  assert.equal(loads, 2, 'the first read at the boundary reloads');
});

test('concurrent callers share one load instead of starting their own', async () => {
  let loads = 0;
  const pending = Promise.withResolvers<number>();
  const read = cachedLoader({
    ttlMs: 60_000,
    load: () => {
      loads += 1;
      return pending.promise;
    }
  });

  const all = Promise.all([read(), read(), read()]);
  pending.resolve(7);
  assert.deepEqual(await all, [7, 7, 7]);
  assert.equal(loads, 1, 'a burst is one query, not one per caller');
  assert.equal(await read(), 7);
  assert.equal(loads, 1);
});

test('a failed load is not cached and the next call retries', async () => {
  let loads = 0;
  const read = cachedLoader({
    ttlMs: 60_000,
    load: async () => {
      loads += 1;
      if (loads === 1) throw new Error('catalog unavailable');
      return 'ok';
    }
  });

  await assert.rejects(read, /catalog unavailable/);
  assert.equal(await read(), 'ok', 'an outage does not pin the failure');
  assert.equal(loads, 2);
});

test('stale-while-revalidate answers from the expired value and refreshes behind it', async () => {
  let clock = 1_000;
  let loads = 0;
  const read = cachedLoader({
    ttlMs: 60_000,
    staleWhileRevalidate: true,
    now: () => clock,
    load: async () => {
      loads += 1;
      return loads;
    }
  });

  assert.equal(await read(), 1, 'the first call has nothing to serve but the load');
  assert.equal(loads, 1);

  clock += 60_000;
  assert.equal(await read(), 1, 'an expired value is served without waiting');
  assert.equal(loads, 2, 'and the reload happens behind the caller');

  // The background load settles on its own microtask turn.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await read(), 2, 'the refreshed value is used from then on');
});

test('a failed background refresh keeps the value it had', async () => {
  let clock = 1_000;
  let loads = 0;
  const read = cachedLoader({
    ttlMs: 10,
    staleWhileRevalidate: true,
    now: () => clock,
    load: async () => {
      loads += 1;
      if (loads > 1) throw new Error('catalog unavailable');
      return 'first';
    }
  });

  assert.equal(await read(), 'first');
  clock += 10;
  assert.equal(await read(), 'first', 'the expired value still answers');
  await setImmediatePromise();
  assert.equal(await read(), 'first', 'a failed refresh does not blank the value');
});

test('a zero ttl always reloads', async () => {
  let loads = 0;
  const read = cachedLoader({
    ttlMs: 0,
    load: async () => {
      loads += 1;
      return loads;
    }
  });

  assert.equal(await read(), 1);
  assert.equal(await read(), 2);
  assert.equal(loads, 2);
});
