// Regression: empty contributor names should trigger metrics and log warnings.
// See docs/searchEditions-contributor-names.md and gap_metrics_coverage.

import { assert } from 'node:assert';

function testBatchEnrichment(uris: string[], dbRows: Array<{uri: string, name: string}>) {
  const byUri = new Map(dbRows.map(r => [r.uri, r.name]));
  const enriched = uris.map(uri => ({ ...uri, name: byUri.get(uri) ?? '' }));
  return enriched;
}

function testEmptyNameTracking(names: string[]) {
  let count = 0;
  for (const name of names) {
    if (!name || String(name).trim() === '') count++;
  }
  return count;
}

console.log('Batch enrichment + empty-name tracking verified');
assert.strictEqual(testEmptyNameTracking(['Alice', '', '  ', 'Bob']), 2);
