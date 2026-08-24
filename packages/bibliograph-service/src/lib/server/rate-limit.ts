/**
 * Per-(ip, nsid) token-bucket rate limiter, in-memory.
 *
 * Each (key) gets a bucket of `RATE_LIMIT_RPM` tokens that refills at
 * `RATE_LIMIT_RPM / 60` per second. The default is intentionally simple; for
 * multi-instance deployments, swap the in-memory Map for Redis.
 */

const DEFAULT_PUBLIC_RPM = Number(process.env.RATE_LIMIT_RPM_PUBLIC ?? 60);
const DEFAULT_PDS_RPM = Number(process.env.RATE_LIMIT_RPM_PDS ?? 600);

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

function isPdsNsid(nsid: string): boolean {
  return nsid.startsWith('com.atproto.');
}

function rpmFor(nsid: string): number {
  return isPdsNsid(nsid) ? DEFAULT_PDS_RPM : DEFAULT_PUBLIC_RPM;
}

function keyFor(ip: string, nsid: string): string {
  return `${ip}::${nsid}`;
}

function takeTokens(key: string, nsid: string, cost: number): boolean {
  const now = Date.now();
  const rpm = rpmFor(nsid);
  const capacity = rpm;
  const refillPerMs = rpm / 60_000;

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefill: now };
    buckets.set(key, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  const refilled = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
  bucket.tokens = refilled;
  bucket.lastRefill = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

/**
 * Returns true if the request is allowed (and consumes a token); false if
 * rate-limited.
 */
export function allowRequest(ip: string, nsid: string): boolean {
  return takeTokens(keyFor(ip, nsid), nsid, 1);
}

/** For tests: reset all buckets. */
export function resetRateLimits(): void {
  buckets.clear();
}
