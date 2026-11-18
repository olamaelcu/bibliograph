
import { expect, test } from 'vitest';
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

  expect(await read()).toBe(1);
  expect(loads).toBe(1);
  clock += 59_999;
  expect(await read()).toBe(1);
  expect(loads, 'a value inside the ttl is reused').toBe(1);

  clock += 1;
  expect(await read()).toBe(2);
  expect(loads, 'the first read at the boundary reloads').toBe(2);
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
  expect(await all).toEqual([7, 7, 7]);
  expect(loads, 'a burst is one query, not one per caller').toBe(1);
  expect(await read()).toBe(7);
  expect(loads).toBe(1);
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

  await expect(read).rejects.toThrow(/catalog unavailable/);
  expect(await read(), 'an outage does not pin the failure').toBe('ok');
  expect(loads).toBe(2);
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

  expect(await read(), 'the first call has nothing to serve but the load').toBe(1);
  expect(loads).toBe(1);

  clock += 60_000;
  expect(await read(), 'an expired value is served without waiting').toBe(1);
  expect(loads, 'and the reload happens behind the caller').toBe(2);

  // The background load settles on its own microtask turn.
  await Promise.resolve();
  await Promise.resolve();
  expect(await read(), 'the refreshed value is used from then on').toBe(2);
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

  expect(await read()).toBe('first');
  clock += 10;
  expect(await read(), 'the expired value still answers').toBe('first');
  await setImmediatePromise();
  expect(await read(), 'a failed refresh does not blank the value').toBe('first');
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

  expect(await read()).toBe(1);
  expect(await read()).toBe(2);
  expect(loads).toBe(2);
});
