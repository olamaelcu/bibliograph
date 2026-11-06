import test from 'node:test';
import assert from 'node:assert/strict';

test('loadRecord editions: returns a loader function', async () => {
  const { loadRecord } = await import('./record-detail.js');
  assert.equal(typeof loadRecord, 'function');
});

test('loadRecord editions: unknown rkey returns notFound', async () => {
  const { loadRecord } = await import('./record-detail.js');
  // A bogus rkey belongs to no provider, so nothing can be fetched for it.
  const result = await loadRecord('editions', 'bogus-rkey');
  // Without a DB row there is nothing left to serve.
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

test('loadRecord publishers: DB miss returns notFound (no provider fallback)', async () => {
  const { loadRecord } = await import('./record-detail.js');
  const result = await loadRecord('publishers', 'does-not-matter');
  // Publishers are only ever served from the database.
  assert.equal(result.notFound, true);
  assert.equal(result.kind, 'publishers');
});