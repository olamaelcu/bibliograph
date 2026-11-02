// Regression for the TAP batch collapse: one redelivered event inside a batch
// used to name the same uri twice in a single INSERT … ON CONFLICT DO UPDATE,
// which Postgres rejects for the whole statement
// ("ON CONFLICT DO UPDATE command cannot affect row a second time") — every
// record in that batch dead-lettered. 778 rows in tap_dead_letter were this.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeByUri, parseRecordUri, uniqueUris } from './tap-batch';

const URI_A = 'at://did:plc:reader/net.olamaelcu.livtet.biblio.bookShelving/ol.OL1M';
const URI_B = 'at://did:plc:reader/net.olamaelcu.livtet.biblio.bookShelving/ol.OL2M';

function row(uri: string, status: string) {
  return { uri, did: 'did:plc:reader', rkey: uri.split('/').pop()!, value: { status } };
}

test('dedupeByUri keeps one entry per uri, last write wins', () => {
  const collapsed = dedupeByUri([
    row(URI_A, 'to-read'),
    row(URI_B, 'reading'),
    row(URI_A, 'read'),
  ]);

  assert.equal(collapsed.length, 2);
  const byUri = new Map(collapsed.map((item) => [item.uri, item]));
  assert.deepEqual(byUri.get(URI_A)?.value, { status: 'read' });
  assert.deepEqual(byUri.get(URI_B)?.value, { status: 'reading' });
});

test('dedupeByUri keeps a uri at its first position', () => {
  const collapsed = dedupeByUri([
    row(URI_A, 'to-read'),
    row(URI_B, 'reading'),
    row(URI_A, 'read'),
  ]);
  assert.deepEqual(
    collapsed.map((item) => item.uri),
    [URI_A, URI_B],
  );
});

test('dedupeByUri is a no-op on a batch without duplicates', () => {
  const items = [row(URI_A, 'read'), row(URI_B, 'read')];
  assert.deepEqual(dedupeByUri(items), items);
});

test('uniqueUris collapses repeated delete events', () => {
  assert.deepEqual(uniqueUris([URI_A, URI_B, URI_A]), [URI_A, URI_B]);
});

test('parseRecordUri splits a record uri', () => {
  assert.deepEqual(parseRecordUri(URI_A), {
    did: 'did:plc:reader',
    collection: 'net.olamaelcu.livtet.biblio.bookShelving',
    rkey: 'ol.OL1M',
  });
});

test('parseRecordUri rejects anything that is not a three-part at-uri', () => {
  for (const bad of [
    '',
    'at://did:plc:reader',
    'at://did:plc:reader/collection-only',
    'at://did:plc:reader/collection/',
    'https://example.com/not-an-at-uri',
    'at://did:plc:reader/collection/rkey/extra',
  ]) {
    assert.equal(parseRecordUri(bad), null, `${bad} should not parse`);
  }
});
