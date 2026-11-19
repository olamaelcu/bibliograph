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
 * `total` is present only on a first page shorter than the requested `limit`,
 * where the page is the whole match set and its length is the exact count.
 * `searchEditions` omits it on a full first page rather than paying a
 * `count(*)` that re-runs the candidate set; a full page is at least `limit`
 * matches, which is not evidence the catalogue lacks the work, so it counts as
 * `enough`. A short page is exact regardless of the caller's `limit`, so it is
 * genuine thin evidence and hydrates below the threshold. Paging (`offset >
 * 0`) never hydrates, and an identifiers-only or language-only body has no
 * provider text query to run.
 */
export function searchHydrationDecision(input: {
  /** At least one of q/title/author is non-blank. */
  hasText: boolean;
  offset: number;
  /** `BookResults.total`, present only on a short first page. */
  total: number | undefined;
  threshold: number;
}): SearchHydrationDecision {
  if (!input.hasText) return 'no_text';
  if (input.offset !== 0) return 'paged';
  // A full first page omits `total`; see the comment above.
  if (input.total === undefined) return 'enough';
  if (input.total < input.threshold) return 'thin';
  return 'enough';
}
