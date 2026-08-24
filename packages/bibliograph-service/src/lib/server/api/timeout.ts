/**
 * Shared HTTP timeout for upstream APIs (OpenLibrary, Google Books, Wikipedia).
 * 10s covers p95 under typical load. Increase via env if upstream quotas tighten.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;
