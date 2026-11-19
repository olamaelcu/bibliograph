import { expect, test } from 'vitest';

import { internalReturnTo } from '../src/lib/server/librarian/return-to.ts';

/**
 * `returnTo` is query-string input and is the target of a redirect, so it is the
 * one place in the sign-in flow where a crafted link could send a freshly signed
 * in librarian somewhere else. Only root-relative paths may pass, and the three
 * shapes that look internal but are not — scheme-absolute, protocol-relative and
 * backslash-relative — must not.
 */

const FALLBACK = '/librarian/claims';

test('a root-relative path is honoured, with its query string intact', () => {
  expect(internalReturnTo('/librarian/claims?page=2', FALLBACK)).toBe('/librarian/claims?page=2');
  expect(internalReturnTo('/', FALLBACK)).toBe('/');
});

test('an absolute URL falls back to the queue', () => {
  expect(internalReturnTo('https://evil.example/x', FALLBACK)).toBe(FALLBACK);
  expect(internalReturnTo('javascript:alert(1)', FALLBACK)).toBe(FALLBACK);
});

test('protocol-relative and backslash-relative paths fall back too', () => {
  expect(internalReturnTo('//evil.example/x', FALLBACK)).toBe(FALLBACK);
  expect(internalReturnTo('/\\evil.example/x', FALLBACK)).toBe(FALLBACK);
});

test('missing or blank values fall back', () => {
  expect(internalReturnTo(null, FALLBACK)).toBe(FALLBACK);
  expect(internalReturnTo(undefined, FALLBACK)).toBe(FALLBACK);
  expect(internalReturnTo('   ', FALLBACK)).toBe(FALLBACK);
});
