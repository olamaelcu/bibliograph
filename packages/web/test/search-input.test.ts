/**
 * The catalog search guard.
 *
 * Both refusals exist because the alternative is a seconds-long statement on a
 * public endpoint: a sub-trigram term seq-scans every search branch (measured:
 * `q: "a"` exceeded the 5 s statement timeout) and a language-only body scans
 * and sorts the whole catalogue (563 ms for the count alone).
 */

import { expect, test } from 'vitest';

import {
  MAX_OFFSET,
  MIN_TEXT_LENGTH,
  offsetProblem,
  searchBodyProblem
} from '../src/lib/server/catalog/search-input.ts';

const none = { identifiers: [] };

test('a text term shorter than a trigram is refused by name', () => {
  for (const field of ['q', 'title', 'author'] as const) {
    const problem = searchBodyProblem({ ...none, [field]: 'ab' });
    expect(problem).toEqual({
      error: 'InvalidRequest',
      message: `${field} must be at least ${MIN_TEXT_LENGTH} characters`
    });
  }
});

test('a term at the minimum length is accepted', () => {
  expect(searchBodyProblem({ ...none, q: 'abc' })).toBeNull();
});

test('a body with no text and no identifier is refused, language is not a hint', () => {
  expect(searchBodyProblem(none)).toEqual({
    error: 'InvalidQuery',
    message: 'supply q, title, author, or at least one identifier'
  });
});

test('an identifier-only body is accepted', () => {
  expect(
    searchBodyProblem({ identifiers: [{ issuer: 'isbn13', value: '9780441478125' }] })
  ).toBeNull();
});

test('offset is capped at the documented page depth', () => {
  expect(offsetProblem(0)).toBeNull();
  expect(offsetProblem(MAX_OFFSET)).toBeNull();
  expect(offsetProblem(MAX_OFFSET + 1)).toEqual({
    error: 'InvalidRequest',
    message: `offset must be at most ${MAX_OFFSET}`
  });
});
