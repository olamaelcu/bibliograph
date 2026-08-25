import test from 'node:test';
import assert from 'node:assert/strict';

test('repro: ol.OL7281956M is valid but currently 404s on DB miss', async () => {
  const { editionRkey } = await import('./ol/keys.js');
  const rkey = editionRkey('OL7281956M');
  assert.equal(rkey, 'ol.OL7281956M');

  const { loadRecord } = await import('./record-detail.js');
  assert.ok(rkey.startsWith('ol.OL'));
});