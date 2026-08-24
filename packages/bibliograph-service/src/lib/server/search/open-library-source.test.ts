import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenLibrarySource } from './open-library-source';

const fakeLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() { return this; },
} as never;

test('OpenLibrarySource constructs and exposes search methods', () => {
  const s = new OpenLibrarySource(fakeLog);
  assert.equal(typeof s.searchEditions, 'function');
  assert.equal(typeof s.searchWorks, 'function');
  assert.equal(typeof s.searchContributors, 'function');
});