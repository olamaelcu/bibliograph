/**
 * Deployment knobs for the cover cache. This is the only cover module that
 * reads the environment, so the rest can be driven by node tests.
 */

import { env } from '$env/dynamic/private';

export const COVER_RATE_LIMIT_DEFAULT = 600;

/** Public origin the XRPC views and records advertise; `''` keeps provider URLs. */
export function coversBaseUrl(): string {
  return (env.COVERS_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
}

/**
 * The directory `bibliograph-worker` writes and this unit reads.
 *
 * `''` when unset: there is no baked-in path, so an unconfigured edge answers
 * every cover from the provider instead of reading a directory nobody named.
 */
export function coversCacheDir(): string {
  return (env.COVERS_CACHE_DIR ?? '').trim();
}

/** Per-client-IP allowance per minute; the burst equals this value. */
export function coversRateLimitPerMinute(): number {
  const parsed = Number.parseInt(env.COVERS_RATE_LIMIT_PER_MINUTE ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : COVER_RATE_LIMIT_DEFAULT;
}
