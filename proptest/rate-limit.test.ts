/**
 * Discovery harness — target 2: `packages/web/src/lib/server/covers/rate-limit.ts`.
 *
 * The model is written from the module's doc comment, in integer micro-tokens,
 * so it cannot inherit the production float arithmetic. Run:
 * `node --test proptest/rate-limit.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createTokenBucket } from '../packages/web/src/lib/server/covers/rate-limit.ts';

const RUNS = 1_000;
const MICRO = 1_000_000;
/** Model-vs-production slack, in micro-tokens: rounding per refill plus float drift. */
const TOL = 200;
const IDLE_MS = 10 * 60 * 1000;

/**
 * Reference bucket: per key, whole micro-tokens and the last refill instant.
 * Refills are `refillPerSecond * elapsedMs * 1000` micro-tokens, rounded once
 * per refill; the production code keeps a float in whole tokens instead.
 */
const makeModel = ({ capacity, refillPerSecond, maxKeys }) => {
  const full = Math.round(capacity * MICRO);
  const microPerMs = refillPerSecond * 1000;
  const buckets = new Map();

  const evict = (at) => {
    if (buckets.size <= maxKeys) return;
    for (const [key, bucket] of buckets) {
      if (buckets.size <= maxKeys) return;
      if (bucket.tokens >= full && at - bucket.updatedAt > IDLE_MS) buckets.delete(key);
    }
    for (const key of buckets.keys()) {
      if (buckets.size <= maxKeys) return;
      buckets.delete(key);
    }
  };

  return {
    take(key, at) {
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { tokens: full, updatedAt: at };
        buckets.set(key, bucket);
        evict(at);
      } else if (at > bucket.updatedAt) {
        const gained = Math.round(microPerMs * (at - bucket.updatedAt));
        bucket.tokens = Math.min(full, bucket.tokens + gained);
        bucket.updatedAt = at;
      }
      const ambiguous = Math.abs(bucket.tokens - MICRO) <= TOL;
      if (bucket.tokens >= MICRO) {
        bucket.tokens -= MICRO;
        return { allowed: true, retryAfterSeconds: 0, ambiguous };
      }
      const missingMicro = MICRO - bucket.tokens;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(missingMicro / microPerMs / 1000)),
        ambiguous
      };
    }
  };
};

const POOL = ['a', 'b', 'c', 'd'];
const poolArb = fc.shuffledSubarray(POOL, { minLength: 1, maxLength: 4 });
const capacityArb = fc.integer({ min: 1, max: 8 });
const refillArb = fc.double({ min: 0.001, max: 5, noNaN: true, noDefaultInfinity: true });

/** Events whose keys come from the generated pool, plus room left under `maxKeys`. */
const scenarioWithoutEviction = fc
  .tuple(
    poolArb,
    fc.array(fc.tuple(fc.integer({ min: 0, max: 5_000 }), fc.nat({ max: 3 })), { maxLength: 40 }),
    capacityArb,
    refillArb,
    fc.nat({ max: 2 })
  )
  .map(([pool, rawEvents, capacity, refillPerSecond, extraKeys]) => ({
    events: rawEvents.map(([delta, slot]) => ({ delta, key: pool[slot % pool.length] })),
    capacity,
    refillPerSecond,
    maxKeys: pool.length + extraKeys
  }));

test('createTokenBucket: decisions, retryAfterSeconds, conservation, no charging for refusals', () => {
  fc.assert(
    fc.property(scenarioWithoutEviction, (scenario) => {
      const { events, capacity, refillPerSecond, maxKeys } = scenario;
      let clock = 0;
      const bucket = createTokenBucket({ capacity, refillPerSecond, maxKeys, now: () => clock });
      const model = makeModel({ capacity, refillPerSecond, maxKeys });
      const grants = new Map();
      const firstTouch = new Map();

      for (const { delta, key } of events) {
        clock += delta;
        const expected = model.take(key, clock);
        const actual = bucket.take(key);

        if (!expected.ambiguous) {
          assert.strictEqual(
            actual.allowed,
            expected.allowed,
            `decision for ${key} at ${clock}ms (tokens near 1 token, model was decisive): capacity=${capacity} refill=${refillPerSecond} maxKeys=${maxKeys}`
          );
        }

        if (actual.allowed) {
          assert.equal(
            actual.retryAfterSeconds,
            0,
            `granted request reports a wait: ${JSON.stringify(actual)}`
          );
          grants.set(key, (grants.get(key) ?? 0) + 1);
          if (!firstTouch.has(key)) firstTouch.set(key, clock);
        } else {
          assert.ok(
            Number.isInteger(actual.retryAfterSeconds) && actual.retryAfterSeconds >= 1,
            `retryAfterSeconds must be a positive integer, got ${actual.retryAfterSeconds}`
          );
          assert.ok(
            actual.retryAfterSeconds <= expected.retryAfterSeconds + 1,
            `retryAfterSeconds=${actual.retryAfterSeconds} understates the wait (model says ${expected.retryAfterSeconds}) for ${key} at ${clock}ms`
          );
        }
      }

      // Nothing is evicted in this scenario, so a key's grants are bounded by its
      // burst plus everything its own refill window could supply.
      for (const [key, count] of grants) {
        const elapsedSeconds = (clock - firstTouch.get(key)) / 1000;
        const allowance = capacity + refillPerSecond * elapsedSeconds;
        assert.ok(
          count <= allowance + 1e-6,
          `${key} was granted ${count} times in ${elapsedSeconds}s, above the ${allowance} conservative allowance`
        );
      }
    }),
    { numRuns: RUNS }
  );
});

test('createTokenBucket: burst size, then refill at the configured rate', () => {
  fc.assert(
    fc.property(capacityArb, refillArb, (capacity, refillPerSecond) => {
      let clock = 0;
      const bucket = createTokenBucket({ capacity, refillPerSecond, now: () => clock });

      for (let index = 0; index < capacity; index += 1) {
        assert.ok(bucket.take('k').allowed, `take ${index + 1} of a fresh burst of ${capacity} refused`);
      }
      const refused = bucket.take('k');
      assert.equal(refused.allowed, false, `burst of ${capacity} exceeded`);

      // Waiting the advertised time must be enough for exactly one request.
      clock += refused.retryAfterSeconds * 1000;
      assert.ok(
        bucket.take('k').allowed,
        `waiting the advertised ${refused.retryAfterSeconds}s was not enough (capacity=${capacity} refill=${refillPerSecond})`
      );
      // Whatever the wait supplied is capped at one burst, never more.
      let granted = 1;
      while (bucket.take('k').allowed) granted += 1;
      assert.ok(
        granted <= capacity,
        `after a ${refused.retryAfterSeconds}s wait the bucket delivered ${granted} requests, above the burst of ${capacity}`
      );
    }),
    { numRuns: 200 }
  );
});

test('createTokenBucket: memory is bounded, oldest buckets are dropped and start full again', () => {
  fc.assert(
    fc.property(capacityArb, refillArb, fc.integer({ min: 1, max: 4 }), (capacity, refillPerSecond, maxKeys) => {
      let clock = 0;
      const bucket = createTokenBucket({ capacity, refillPerSecond, maxKeys, now: () => clock });

      // One key more than the map may hold, all at the same instant.
      for (let index = 0; index <= maxKeys; index += 1) bucket.take(`k${index}`);

      // The newest key survived the eviction with the rest of its burst intact.
      for (let index = 1; index < capacity; index += 1) {
        assert.ok(
          bucket.take(`k${maxKeys}`).allowed,
          `the newest key lost part of its burst after eviction (take ${index + 1}/${capacity}, maxKeys=${maxKeys})`
        );
      }
      assert.equal(
        bucket.take(`k${maxKeys}`).allowed,
        false,
        `the newest key was granted more than its burst of ${capacity}`
      );

      clock += IDLE_MS + 1;
      for (let index = 0; index < capacity; index += 1) {
        assert.ok(
          bucket.take('k0').allowed,
          `evicted key k0 did not get a full burst (take ${index + 1}/${capacity}, maxKeys=${maxKeys})`
        );
      }
      assert.equal(
        bucket.take('k0').allowed,
        false,
        'evicted key granted more than a full burst after coming back'
      );
    }),
    { numRuns: 200 }
  );
});
