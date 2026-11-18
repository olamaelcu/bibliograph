import { expect, test } from 'vitest';

import {
  SEARCH_HYDRATION_THRESHOLD_DEFAULT,
  searchHydrationDecision,
  searchHydrationThreshold
} from '../src/lib/server/catalog/search-hydration.ts';

/**
 * The trigger is the only thing that spends provider quota, so its predicate
 * and its parser are pinned here: the module has no imports, which is what lets
 * `vitest` load it without a database or `$env`.
 */

test('searchHydrationDecision enqueues only a thin first page', () => {
  const base = { hasText: true, offset: 0, total: 0, threshold: 10 };
  expect(searchHydrationDecision({ ...base, total: 9 })).toBe('thin');
  expect(searchHydrationDecision({ ...base, total: 10 })).toBe('enough');
  expect(searchHydrationDecision({ ...base, total: 0 })).toBe('thin');
});

test('searchHydrationDecision skips bodies without a provider text query', () => {
  expect(searchHydrationDecision({ hasText: false, offset: 0, total: 0, threshold: 10 })).toBe('no_text');
});

test('searchHydrationDecision skips paging, where total is absent', () => {
  expect(searchHydrationDecision({ hasText: true, offset: 25, total: undefined, threshold: 10 })).toBe('paged');
  expect(searchHydrationDecision({ hasText: true, offset: 0, total: undefined, threshold: 10 })).toBe('paged');
});

test('searchHydrationDecision follows the threshold, and 0 disables it', () => {
  expect(searchHydrationDecision({ hasText: true, offset: 0, total: 4, threshold: 5 })).toBe('thin');
  expect(searchHydrationDecision({ hasText: true, offset: 0, total: 5, threshold: 5 })).toBe('enough');
  expect(searchHydrationDecision({ hasText: true, offset: 0, total: 0, threshold: 0 })).toBe('enough');
});

test('searchHydrationThreshold accepts non-negative integers only', () => {
  expect(searchHydrationThreshold('7')).toBe(7);
  expect(searchHydrationThreshold(' 7 ')).toBe(7);
  expect(searchHydrationThreshold('0')).toBe(0);
  expect(searchHydrationThreshold('')).toBe(SEARCH_HYDRATION_THRESHOLD_DEFAULT);
  expect(searchHydrationThreshold(undefined)).toBe(SEARCH_HYDRATION_THRESHOLD_DEFAULT);
  expect(searchHydrationThreshold('abc')).toBe(SEARCH_HYDRATION_THRESHOLD_DEFAULT);
  expect(searchHydrationThreshold('-1')).toBe(SEARCH_HYDRATION_THRESHOLD_DEFAULT);
  expect(searchHydrationThreshold('2.5')).toBe(SEARCH_HYDRATION_THRESHOLD_DEFAULT);
});

