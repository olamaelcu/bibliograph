/**
 * Trigger policy for provider hydration of `searchEditions`.
 *
 * This module is the single home of the numbers and the predicate, and it has
 * no imports on purpose: `jobs.ts` reaches `$env` through `./db`, so a test can
 * only load the decision by importing a file that stands alone.
 */

/** Default first-page total below which a text search hydrates from providers. */
export const SEARCH_HYDRATION_THRESHOLD_DEFAULT = 10;

/** Rolling-hour budget for `catalog.search` enqueues, across all queries. */
export const SEARCH_HYDRATION_PER_HOUR = 120;

/** Key prefix of the `catalog_enqueue_marks` rows that carry the search budget. */
export const SEARCH_HYDRATION_MARK_PREFIX = 'search:';

/** `SEARCH_HYDRATION_THRESHOLD` as a count; blank, non-integer or negative → default. 0 disables. */
export function searchHydrationThreshold(raw?: string): number {
  const text = (raw ?? '').trim();
  if (text === '') return SEARCH_HYDRATION_THRESHOLD_DEFAULT;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : SEARCH_HYDRATION_THRESHOLD_DEFAULT;
}

/**
 * What one handled `searchEditions` call decided about provider hydration.
 * `thin` is the only value that enqueues; all four are metric label values.
 */
export type SearchHydrationDecision = 'thin' | 'enough' | 'paged' | 'no_text';

/**
 * `total` only exists on the first page, so paging never re-fires; a shallow
 * first page from a caller's own `limit` is not thin evidence either, which is
 * why page length is never consulted. An identifiers-only or language-only body
 * has no provider text query to run.
 */
export function searchHydrationDecision(input: {
  /** At least one of q/title/author is non-blank. */
  hasText: boolean;
  offset: number;
  /** `EditionResults.total`, present only at `offset === 0`. */
  total: number | undefined;
  threshold: number;
}): SearchHydrationDecision {
  if (!input.hasText) return 'no_text';
  if (input.offset !== 0 || input.total === undefined) return 'paged';
  if (input.total < input.threshold) return 'thin';
  return 'enough';
}
