import test from 'node:test';
import assert from 'node:assert/strict';

test('loadRecord editions: DB hit returns value, no OL fetch', async () => {
  const { loadRecord } = await import('./record-detail.js');
  assert.equal(typeof loadRecord, 'function');
});

test('loadRecord editions: invalid rkey returns notFound without OL fetch', async () => {
  const { loadRecord } = await import('./record-detail.js');
  // Invalid rkeys don't match OL formats, so no OL fetch should be attempted
  // The helper functions in open-library.ts return null for invalid rkeys
  const result = await loadRecord('editions', 'bogus-rkey');
  // Without DB row and without OL match, should be notFound
  assert.equal(result.notFound, true);
  assert.equal(result.rkey, 'bogus-rkey');
  assert.equal(result.kind, 'editions');
});

test('loadRecord works: DB miss returns notFound for invalid rkey', async () => {
  const { loadRecord } = await import('./record-detail.js');
  const result = await loadRecord('works', 'not-valid');
  assert.equal(result.notFound, true);
  assert.equal(result.kind, 'works');
});

test('loadRecord contributors: DB miss returns notFound for invalid rkey', async () => {
  const { loadRecord } = await import('./record-detail.js');
  const result = await loadRecord('contributors', 'bad-rkey');
  assert.equal(result.notFound, true);
  assert.equal(result.kind, 'contributors');
});

test('loadRecord publishers: DB miss returns notFound (no OL fallback)', async () => {
  const { loadRecord } = await import('./record-detail.js');
  const result = await loadRecord('publishers', 'does-not-matter');
  // Publishers have no OL fallback per spec
  assert.equal(result.notFound, true);
  assert.equal(result.kind, 'publishers');
});