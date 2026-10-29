/**
 * Single source of truth for "does this contributor name satisfy the lexicon?".
 *
 * `community.lexicon.book.contributor` declares `name` as
 * `{ "type": "string", "minLength": 1 }`. The `contributors.name` column is
 * `NOT NULL`, but that still admits `''` and whitespace-only values, so an
 * unfiltered read can emit a record that violates the schema the endpoint
 * advertises. Every read path that can put a name on the wire must run the
 * value through this predicate.
 */
export function validContributorName(name: unknown): boolean {
  return typeof name === 'string' && name.trim() !== '';
}
