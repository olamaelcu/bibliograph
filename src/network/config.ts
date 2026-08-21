/**
 * Network client configuration. Resolves once at import.
 *
 * Override defaults via env vars:
 *   CONSTELLATION_URL          — defaults to public instance
 *   NETWORK_TIMEOUT_MS         — request timeout (default 2000)
 *   NETWORK_CACHE_TTL_MS       — cache TTL in ms (default 300000 = 5 min)
 */

export const CONSTELLATION_URL: string =
  process.env.CONSTELLATION_URL ?? 'https://constellation.microcosm.blue';

export const NETWORK_TIMEOUT_MS: number = (() => {
  const raw = process.env.NETWORK_TIMEOUT_MS;
  if (!raw) return 2000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();

export const NETWORK_CACHE_TTL_MS: number = (() => {
  const raw = process.env.NETWORK_CACHE_TTL_MS;
  if (!raw) return 300_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
})();

export const USER_AGENT = 'bibliograph/0.1 (+contact: github.com/olamaelcu/bibliograph)';