/**
 * Per-key token bucket for the cover endpoint.
 *
 * A cover request is cheap but not free (a `stat`, a file read), and the URL
 * space is the whole catalog, so a single client must not be able to walk it at
 * will. `capacity` is both the burst and the per-window allowance: the route
 * sizes it to `COVERS_RATE_LIMIT_PER_MINUTE` and refills at that rate / 60.
 *
 * Memory is bounded by `maxKeys`: full, idle buckets are dropped first, then the
 * oldest insertion-order entries, so a scan from many addresses cannot grow the
 * map without limit.
 */

export type TokenBucket = {
  take(key: string): { allowed: boolean; retryAfterSeconds: number };
};

type Bucket = { tokens: number; updatedAt: number };

const IDLE_MS = 10 * 60 * 1000;

export function createTokenBucket(options: {
  /** Burst size, and the allowance per refill window. */
  capacity: number;
  /** Tokens gained per second; `capacity / 60` for a per-minute setting. */
  refillPerSecond: number;
  maxKeys?: number;
  /** Milliseconds; injectable so tests need no clock. */
  now?: () => number;
}): TokenBucket {
  const capacity = Math.max(1, options.capacity);
  const refillPerSecond = options.refillPerSecond > 0 ? options.refillPerSecond : capacity / 60;
  const maxKeys = Math.max(1, options.maxKeys ?? 10_000);
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  function refill(bucket: Bucket, at: number): void {
    const elapsedSeconds = Math.max(0, (at - bucket.updatedAt) / 1000);
    if (elapsedSeconds <= 0) return;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.updatedAt = at;
  }

  function evict(at: number): void {
    if (buckets.size <= maxKeys) return;
    for (const [key, bucket] of buckets) {
      if (buckets.size <= maxKeys) return;
      if (bucket.tokens >= capacity && at - bucket.updatedAt > IDLE_MS) buckets.delete(key);
    }
    // Still over: `Map` iterates in insertion order, so this drops the oldest.
    for (const key of buckets.keys()) {
      if (buckets.size <= maxKeys) return;
      buckets.delete(key);
    }
  }

  return {
    take(key: string) {
      const at = now();
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { tokens: capacity, updatedAt: at };
        buckets.set(key, bucket);
        evict(at);
      } else {
        refill(bucket, at);
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const missing = 1 - bucket.tokens;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(missing / refillPerSecond))
      };
    }
  };
}
