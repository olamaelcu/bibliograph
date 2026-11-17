/**
 * Discovery harness — target 3: `packages/web/src/lib/server/cached-loader.ts`.
 *
 * `fc.commands` over a reference loader written from the module's doc comment:
 * explicit `fresh | stale | loading` state, its own call counter, deferred
 * promises and an injected clock. Run:
 * `node --test proptest/cached-loader.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { cachedLoader } from '../packages/web/src/lib/server/cached-loader.ts';

const RUNS = 1_000;
const NO_VALUE = Symbol('no value');

/** One macrotask: every microtask queued by a settlement has run by then. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

const track = (promise) => {
  const record = { settled: false, value: NO_VALUE, error: undefined };
  promise.then(
    (value) => {
      record.settled = true;
      record.value = value;
    },
    (error) => {
      record.settled = true;
      record.error = error;
    }
  );
  return record;
};

const makeReal = (config) => {
  const real = {
    config,
    clock: 0,
    loadStarts: 0,
    /** The deferred `load` this harness controls; at most one load is in flight. */
    pending: null,
    /** Reads that are waiting on a load rather than on the cache. */
    awaiting: [],
    loader: null
  };
  real.loader = cachedLoader({
    ttlMs: config.ttlMs,
    staleWhileRevalidate: config.staleWhileRevalidate,
    now: () => real.clock,
    load: () => {
      real.loadStarts += 1;
      const { promise, resolve, reject } = Promise.withResolvers();
      real.pending = { resolve, reject };
      return promise;
    }
  });
  return real;
};

const makeModel = () => ({
  clock: 0,
  value: NO_VALUE,
  loadedAt: null,
  inFlight: false,
  loadStarts: 0
});

/** Which branch the doc comment says a read must take right now. */
const predict = (model, config) => {
  const hasValue = model.loadedAt !== null;
  if (hasValue && model.clock - model.loadedAt < config.ttlMs) return 'fresh';
  if (hasValue && config.staleWhileRevalidate) return 'stale';
  return 'load';
};

class ReadCommand {
  toString() {
    return 'Read';
  }

  check() {
    return true;
  }

  async run(model, real) {
    const kind = predict(model, real.config);
    const startsBefore = real.loadStarts;
    const record = track(real.loader());
    await drain();

    if (kind === 'fresh') {
      assert.equal(real.loadStarts, startsBefore, 'a fresh value was not served from the cache');
      assert.ok(record.settled, 'a fresh read did not resolve');
      assert.deepStrictEqual(record.value, model.value, 'a fresh read returned a different value');
      return;
    }

    if (kind === 'stale') {
      assert.ok(record.settled, 'stale-while-revalidate made the caller wait for the refresh');
      assert.deepStrictEqual(record.value, model.value, 'a stale read returned a different value');
      if (model.inFlight) {
        assert.equal(
          real.loadStarts,
          startsBefore,
          'a stale read started a second refresh while one was in flight'
        );
        return;
      }
      assert.equal(real.loadStarts, startsBefore + 1, 'a stale read did not start exactly one refresh');
      model.inFlight = true;
      model.loadStarts += 1;
      return;
    }

    if (model.inFlight) {
      assert.equal(
        real.loadStarts,
        startsBefore,
        'a concurrent read started its own load instead of sharing the in-flight one'
      );
      assert.equal(record.settled, false, 'a read resolved while its shared load was still in flight');
      real.awaiting.push(record);
      return;
    }

    assert.equal(
      real.loadStarts,
      startsBefore + 1,
      'a missing or expired value did not start exactly one load'
    );
    assert.equal(record.settled, false, 'a read resolved before its load settled');
    real.awaiting.push(record);
    model.inFlight = true;
    model.loadStarts += 1;
  }
}

class AdvanceClockCommand {
  constructor(deltaMs) {
    this.deltaMs = deltaMs;
  }

  toString() {
    return `AdvanceClock(${this.deltaMs})`;
  }

  check() {
    return true;
  }

  run(model, real) {
    model.clock += this.deltaMs;
    real.clock += this.deltaMs;
  }
}

class ResolveLoadCommand {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return `ResolveLoad(${JSON.stringify(this.value)})`;
  }

  check(model) {
    return model.inFlight;
  }

  async run(model, real) {
    assert.notEqual(real.pending, null, 'no load was in flight on the real side');
    const { resolve } = real.pending;
    real.pending = null;
    resolve(this.value);
    await drain();

    for (const record of real.awaiting) {
      assert.ok(record.settled, 'a caller was left waiting after its load settled');
      assert.deepStrictEqual(
        record.value,
        this.value,
        'a caller received a value the source never returned'
      );
    }
    real.awaiting = [];

    model.value = this.value;
    model.loadedAt = model.clock;
    model.inFlight = false;
    model.loadStarts = real.loadStarts;
  }
}

class RejectLoadCommand {
  toString() {
    return 'RejectLoad';
  }

  check(model) {
    return model.inFlight;
  }

  async run(model, real) {
    assert.notEqual(real.pending, null, 'no load was in flight on the real side');
    const { reject } = real.pending;
    real.pending = null;
    const failure = new Error('source unavailable');
    reject(failure);
    await drain();

    for (const record of real.awaiting) {
      assert.ok(record.settled, 'a caller was left waiting after its load failed');
      assert.equal(record.error, failure, 'a caller did not receive the source failure');
    }
    real.awaiting = [];

    model.inFlight = false;
    model.loadStarts = real.loadStarts;
  }
}

const valueArb = fc.oneof(fc.integer(), fc.string({ maxLength: 4 }));

const commandsArb = fc.commands(
  [
    fc.constant(new ReadCommand()),
    fc.integer({ min: 0, max: 2_000 }).map((deltaMs) => new AdvanceClockCommand(deltaMs)),
    valueArb.map((value) => new ResolveLoadCommand(value)),
    fc.constant(new RejectLoadCommand())
  ],
  { maxCommands: 12 }
);

const configArb = fc.record({
  ttlMs: fc.integer({ min: 0, max: 1_000 }),
  staleWhileRevalidate: fc.boolean()
});

test('cachedLoader: model-based run over read, clock advance, resolve and reject', async () => {
  await fc.assert(
    fc.asyncProperty(configArb, commandsArb, async (config, commands) => {
      const real = makeReal(config);
      const model = makeModel();

      await fc.asyncModelRun(() => ({ model, real }), commands);

      assert.equal(real.loadStarts, model.loadStarts, 'load call count diverged from the model');
      if (!model.inFlight) assert.equal(real.pending, null, 'a load stayed in flight with no caller');
    }),
    { numRuns: RUNS }
  );
});

test('cachedLoader: stale-while-revalidate never blocks a caller that already has a value', async () => {
  let clock = 0;
  let loads = 0;
  let settle = null;
  const loader = cachedLoader({
    ttlMs: 100,
    staleWhileRevalidate: true,
    now: () => clock,
    load: () => {
      loads += 1;
      const { promise, resolve } = Promise.withResolvers();
      settle = resolve;
      return promise;
    }
  });

  const first = loader();
  assert.equal(loads, 1);
  settle('v1');
  await drain();
  assert.equal(await first, 'v1');

  clock += 1_000;
  const second = loader();
  assert.equal(loads, 2, 'the expired read did not start a refresh');
  assert.equal(await second, 'v1', 'the caller waited for the refresh instead of taking the stale value');

  // A burst of expired reads shares the one refresh already in flight.
  for (let index = 0; index < 5; index += 1) assert.equal(await loader(), 'v1');
  assert.equal(loads, 2, 'a burst of expired reads started more than one refresh');

  settle('v2');
  await drain();
  assert.equal(await loader(), 'v2', 'the refreshed value was not picked up');
});

test('cachedLoader: failed loads are not cached and the next read retries', async () => {
  let clock = 0;
  let loads = 0;
  const loader = cachedLoader({
    ttlMs: 1_000,
    now: () => clock,
    load: () => {
      loads += 1;
      return loads === 1 ? Promise.reject(new Error('first attempt')) : Promise.resolve('v1');
    }
  });

  await assert.rejects(loader(), /first attempt/);
  assert.equal(await loader(), 'v1', 'a failed load left the loader broken');
  assert.equal(loads, 2);
  assert.equal(await loader(), 'v1');
  assert.equal(loads, 2, 'a successful load was not cached');

  clock += 1_000;
  const refreshed = loader();
  assert.equal(loads, 3, 'an expired value did not refresh');
  assert.equal(await refreshed, 'v1');
});
