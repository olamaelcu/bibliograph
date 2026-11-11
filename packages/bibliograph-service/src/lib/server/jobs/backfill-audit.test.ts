import test from 'node:test';
import assert from 'node:assert/strict';
import { mapReason } from './backfill-audit';

test('successful backfills map to updated/created', () => {
  assert.equal(mapReason('backfill-edition-description', 'ok'), 'updated');
  assert.equal(mapReason('backfill-edition-cover', 'ok'), 'updated');
  assert.equal(mapReason('backfill-edition-isbn', 'ok'), 'updated');
  assert.equal(mapReason('backfill-edition-format', 'updated'), 'updated');
  assert.equal(mapReason('backfill-contributor-image', 'ok'), 'updated');
  assert.equal(mapReason('backfill-contributor-bio', 'ok'), 'updated');
  assert.equal(mapReason('backfill-shelving-edition', 'created'), 'created');
});

test('already satisfied no-ops map to already', () => {
  assert.equal(mapReason('backfill-edition-description', 'already_has_description'), 'already');
  assert.equal(mapReason('backfill-edition-cover', 'already_has_cover'), 'already');
  assert.equal(mapReason('backfill-edition-isbn', 'already_has_isbn'), 'already');
  assert.equal(mapReason('backfill-edition-format', 'no_isbn'), 'already');
  assert.equal(mapReason('backfill-edition-format', 'already_complete'), 'already');
  assert.equal(mapReason('backfill-edition-format', 'no_change'), 'already');
  assert.equal(mapReason('backfill-contributor-image', 'already_checked'), 'already');
  assert.equal(mapReason('backfill-contributor-image', 'already_has_image'), 'already');
  assert.equal(mapReason('backfill-contributor-bio', 'already_has_bio'), 'already');
  assert.equal(mapReason('backfill-shelving-edition', 'already_present'), 'already');
});

test('genuine misses map to miss or deferred/blocked', () => {
  assert.equal(mapReason('backfill-edition-description', 'no_description_found'), 'miss');
  assert.equal(mapReason('backfill-edition-description', 'deferred'), 'deferred');
  assert.equal(mapReason('backfill-edition-cover', 'no_cover_found'), 'miss');
  assert.equal(mapReason('backfill-edition-isbn', 'found'), 'miss');
  assert.equal(mapReason('backfill-edition-isbn', 'ambiguous'), 'miss');
  assert.equal(mapReason('backfill-edition-format', 'not_found'), 'miss');
  assert.equal(mapReason('backfill-edition-format', 'blocked'), 'blocked');
  assert.equal(mapReason('backfill-contributor-image', 'no_image_found'), 'miss');
  assert.equal(mapReason('backfill-contributor-image', 'deferred'), 'deferred');
  assert.equal(mapReason('backfill-contributor-bio', 'no_bio_found'), 'miss');
  assert.equal(mapReason('backfill-shelving-edition', 'provider_miss'), 'miss');
});

test('missing catalog rows and malformed input map to absent or invalid', () => {
  assert.equal(mapReason('backfill-edition-description', 'not_found'), 'absent');
  assert.equal(mapReason('backfill-edition-description', 'update_missed'), 'absent');
  assert.equal(mapReason('backfill-edition-description', 'missing_identifiers'), 'invalid');
  assert.equal(mapReason('backfill-edition-isbn', 'not_catalog_record'), 'invalid');
  assert.equal(mapReason('backfill-edition-format', 'no_row'), 'invalid');
  assert.equal(mapReason('backfill-contributor-bio', 'not_found'), 'absent');
});

test('an unknown reason maps to invalid rather than mislabeled success', () => {
  assert.equal(mapReason('backfill-edition-description', 'something_new'), 'invalid');
  assert.equal(mapReason('backfill-edition-format', 'driver_unexpected'), 'invalid');
  assert.equal(mapReason('backfill-shelving-edition', 'whatever'), 'invalid');
});

test('a missing reason maps to invalid, never to success', () => {
  assert.equal(mapReason('backfill-edition-description', undefined), 'invalid');
  assert.equal(mapReason('backfill-edition-cover', undefined), 'invalid');
});
