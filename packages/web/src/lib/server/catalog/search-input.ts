/**
 * What a `searchEditions` body must satisfy to be answered.
 *
 * The catalog search is public, and two shapes of request have no bounded plan:
 *
 *   * a text term shorter than three characters — a trigram index cannot serve
 *     the pattern, so every branch of the candidate union seq-scans its table
 *     (measured: `q: "a"` did not finish inside the 5 s statement timeout);
 *   * a body with only `language` — there is no candidate set to narrow to, so
 *     the query scans `books`, joins the shape claim and sorts the catalogue
 *     (measured 563 ms for the count alone, and an external-merge sort of the
 *     whole catalogue when `sort=title` is asked for).
 *
 * Both are rejected as invalid rather than answered slowly. `offset` is bounded
 * for the same reason: it is an unbounded public knob on an `OFFSET` scan.
 */

export const MIN_TEXT_LENGTH = 3;

/** Deepest page a catalog listing will answer (`offset` is a row count). */
export const MAX_OFFSET = 10_000;

export type SearchBodyProblem = { error: 'InvalidRequest' | 'InvalidQuery'; message: string };

/**
 * A reason the body cannot be answered, or null. `q`, `title` and `author` are
 * already trimmed and empty-string-free by the caller; `identifiers` is the
 * parsed list (length is all that matters here).
 */
export function searchBodyProblem(input: {
  q?: string;
  title?: string;
  author?: string;
  identifiers: readonly unknown[];
}): SearchBodyProblem | null {
  for (const [name, value] of [
    ['q', input.q],
    ['title', input.title],
    ['author', input.author]
  ] as const) {
    if (value !== undefined && value.length < MIN_TEXT_LENGTH) {
      return {
        error: 'InvalidRequest',
        message: `${name} must be at least ${MIN_TEXT_LENGTH} characters`
      };
    }
  }
  if (!input.q && !input.title && !input.author && input.identifiers.length === 0) {
    return {
      error: 'InvalidQuery',
      message: 'supply q, title, author, or at least one identifier'
    };
  }
  return null;
}

/** A reason the offset cannot be answered, or null. */
export function offsetProblem(offset: number): SearchBodyProblem | null {
  return offset > MAX_OFFSET
    ? { error: 'InvalidRequest', message: `offset must be at most ${MAX_OFFSET}` }
    : null;
}
