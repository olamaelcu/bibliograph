// Replay protection for inter-service auth JWTs.
//
// A service JWT is valid for its whole `exp` window (the PDS mints 60 s by
// default, and the verifier accepts up to `maxAge`), so an intercepted token is
// replayable until it expires. `ServiceJwtVerifier` asks this store about every
// `(iss, jti)` pair and rejects one it has already seen.
//
// In-memory is correct for this deployment: one container, one process. If the
// service ever runs more than one instance, back this with Postgres (the
// `web_sessions` table shows the pattern) or a shared cache, otherwise a replay
// crossing instances would go unnoticed.

import type { ReplayStore } from '@atcute/xrpc-server/auth';

/** Drop expired keys once the map grows past this, so memory stays bounded. */
const PRUNE_AT_SIZE = 1_000;

export function createInMemoryReplayStore(
  now: () => number = Date.now,
): ReplayStore {
  const seen = new Map<string, number>();

  function prune(at: number): void {
    if (seen.size < PRUNE_AT_SIZE) return;
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= at) seen.delete(key);
    }
  }

  return {
    async check({ iss, jti }, ttlSeconds) {
      const at = now();
      prune(at);
      const key = `${iss}\u0000${jti}`;
      const expiresAt = seen.get(key);
      if (expiresAt !== undefined && expiresAt > at) return false;
      seen.set(key, at + ttlSeconds * 1_000);
      return true;
    },
  };
}
