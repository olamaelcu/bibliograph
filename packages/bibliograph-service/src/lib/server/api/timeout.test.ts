import test from 'node:test';
import assert from 'node:assert/strict';
import { UPSTREAM_TIMEOUT_MS } from './timeout';

test('UPSTREAM_TIMEOUT_MS is 10_000', () => {
  assert.equal(UPSTREAM_TIMEOUT_MS, 10_000);
});
