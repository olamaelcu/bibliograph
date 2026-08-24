/**
 * Shared HTTP timeout for upstream APIs (OpenLibrary, Google Books, Wikipedia).
 * 10s covers p95 under typical load. Increase via env if upstream quotas tighten.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Total search-pipeline timeout (ms) — bounds the whole request, not per upstream.
 * Set REQUEST_TIMEOUT_MS env var to override.
 */
export const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15_000);