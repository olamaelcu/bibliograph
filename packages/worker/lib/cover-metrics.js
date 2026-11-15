/**
 * In-memory counters for cover downloads, rendered by the metrics endpoint.
 *
 * `catalog.covers` runs in this process only (graphile serialises the batch), so
 * a process-local counter is the whole history since boot; the ledger in
 * Postgres stays the durable record. The endpoint reads a snapshot on scrape, so
 * a counter never needs a scrape to exist to be counted.
 */

/**
 * @typedef {{ result: 'cached' | 'rejected' | 'retry', status: string }} CoverOutcome
 */

/** A fresh counter set; the worker creates one and shares it with the endpoint. */
export function createCoverMetrics() {
  /** @type {Map<string, { result: string, status: string, count: number }>} */
  const counts = new Map();

  // Files, not attempts: the disk footprint is what outlives a task, and an
  // operator cannot derive it from the outcome series alone (a `cached` call is
  // one file now, a `retry` is none).
  const totals = { writes: 0, writeBytes: 0, removals: 0 };

  return {
    /**
     * Count one download attempt.
     *
     * `result` is the classification (`cached`, `rejected`, `retry`) and
     * `status` the HTTP status that produced it, or `none` when no response
     * arrived. Both are bounded sets drawn from this file's callers.
     */
    record(result, status) {
      const key = `${result}\u0000${status}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      counts.set(key, { result, status, count: 1 });
    },

    /** Sorted, copy-on-read view for the exposition; safe to hold across scrapes. */
    snapshot() {
      return [...counts.values()]
        .map((entry) => ({ ...entry }))
        .sort(
          (a, b) => a.result.localeCompare(b.result) || a.status.localeCompare(b.status)
        );
    },

    /** One cover image file written to the cache, with its size in bytes. */
    recordWrite(byteSize) {
      totals.writes += 1;
      totals.writeBytes += Math.max(0, Math.trunc(Number(byteSize) || 0));
    },

    /** One cached cover file removed (a stale source, or a re-download). */
    recordRemoval() {
      totals.removals += 1;
    },

    /** Copy-on-read totals for the exposition. */
    counters() {
      return { ...totals };
    }
  };
}
