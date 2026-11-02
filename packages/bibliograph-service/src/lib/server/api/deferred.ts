/**
 * Raised when an upstream could not be asked *at all* — its circuit breaker was
 * open, or the request itself failed — as opposed to answering "nothing found".
 *
 * The distinction matters because the backfills persist a permanent-miss stamp
 * (`description_checked_at`, `image_checked_at`, `bio_checked_at`) so a rerun
 * never repeats an authoritative negative. Recording a deferral as one poisons
 * the row: the entity is never retried, and a breaker that opened for a few
 * seconds under load silently excludes thousands of rows forever.
 */
export class UpstreamDeferred extends Error {
  constructor(
    readonly upstream: string,
    readonly reason: 'breaker-open' | 'request-failed',
  ) {
    super(`${upstream} deferred (${reason})`);
    this.name = 'UpstreamDeferred';
  }
}
