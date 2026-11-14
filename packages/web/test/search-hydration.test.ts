import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEARCH_HYDRATION_THRESHOLD_DEFAULT,
  searchHydrationDecision,
  searchHydrationThreshold
} from '../src/lib/server/catalog/search-hydration.ts';

/**
 * The trigger is the only thing that spends provider quota, so its predicate
 * and its parser are pinned here: the module has no imports, which is what lets
 * `node --test` load it without a database or `$env`.
 */

test('searchHydrationDecision enqueues only a thin first page', () => {
  const base = { hasText: true, offset: 0, total: 0, threshold: 10 };
  assert.equal(searchHydrationDecision({ ...base, total: 9 }), 'thin');
  assert.equal(searchHydrationDecision({ ...base, total: 10 }), 'enough');
  assert.equal(searchHydrationDecision({ ...base, total: 0 }), 'thin');
});

test('searchHydrationDecision skips bodies without a provider text query', () => {
  assert.equal(
    searchHydrationDecision({ hasText: false, offset: 0, total: 0, threshold: 10 }),
    'no_text'
  );
});

test('searchHydrationDecision skips paging, where total is absent', () => {
  assert.equal(
    searchHydrationDecision({ hasText: true, offset: 25, total: undefined, threshold: 10 }),
    'paged'
  );
  assert.equal(
    searchHydrationDecision({ hasText: true, offset: 0, total: undefined, threshold: 10 }),
    'paged'
  );
});

test('searchHydrationDecision follows the threshold, and 0 disables it', () => {
  assert.equal(
    searchHydrationDecision({ hasText: true, offset: 0, total: 4, threshold: 5 }),
    'thin'
  );
  assert.equal(
    searchHydrationDecision({ hasText: true, offset: 0, total: 5, threshold: 5 }),
    'enough'
  );
  assert.equal(
    searchHydrationDecision({ hasText: true, offset: 0, total: 0, threshold: 0 }),
    'enough'
  );
});

test('searchHydrationThreshold accepts non-negative integers only', () => {
  assert.equal(searchHydrationThreshold('7'), 7);
  assert.equal(searchHydrationThreshold(' 7 '), 7);
  assert.equal(searchHydrationThreshold('0'), 0);
  assert.equal(searchHydrationThreshold(''), SEARCH_HYDRATION_THRESHOLD_DEFAULT);
  assert.equal(searchHydrationThreshold(undefined), SEARCH_HYDRATION_THRESHOLD_DEFAULT);
  assert.equal(searchHydrationThreshold('abc'), SEARCH_HYDRATION_THRESHOLD_DEFAULT);
  assert.equal(searchHydrationThreshold('-1'), SEARCH_HYDRATION_THRESHOLD_DEFAULT);
  assert.equal(searchHydrationThreshold('2.5'), SEARCH_HYDRATION_THRESHOLD_DEFAULT);
});

