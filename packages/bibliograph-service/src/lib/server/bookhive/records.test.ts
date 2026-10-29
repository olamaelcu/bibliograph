import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOKHIVE_BACKLINK_SOURCE, normalizeBookhiveBook, shelfForBookhiveStatus } from './records';
import { BOOKHIVE_DID, bhEditionUri, bookhiveCatalogUri } from './keys';

const HIVE_ID = 'bk_Wf9C5GP9iEGH6hqNNtwW';

// Shape observed on a real third-party PDS.
const RECORD = {
  $type: 'buzz.bookhive.book',
  stars: 9,
  title: 'The Creative Act: A Way of Being',
  hiveId: HIVE_ID,
  review: 'A beautiful insight into creativity',
  status: 'buzz.bookhive.defs#finished',
  authors: 'Rick Rubin',
  createdAt: '2024-12-08T21:38:15.683Z',
  hiveBookUri: `at://${BOOKHIVE_DID}/buzz.bookhive.catalogBook/${HIVE_ID}`,
};

test('normalizeBookhiveBook maps a review with its 1-10 rating', () => {
  const norm = normalizeBookhiveBook(RECORD);
  assert.deepEqual(norm.review, {
    text: 'A beautiful insight into creativity',
    rating: 9,
    createdAt: '2024-12-08T21:38:15.683Z',
  });
});

test('normalizeBookhiveBook maps status to a Bibliograph shelf', () => {
  assert.deepEqual(normalizeBookhiveBook(RECORD).shelf, {
    rkey: 'read',
    status: 'read',
    name: 'Read',
  });
  assert.deepEqual(shelfForBookhiveStatus('buzz.bookhive.defs#reading'), {
    rkey: 'reading',
    status: 'reading',
    name: 'Currently Reading',
  });
  assert.deepEqual(shelfForBookhiveStatus('buzz.bookhive.defs#wantToRead'), {
    rkey: 'to-read',
    status: 'to-read',
    name: 'To Read',
  });
  assert.deepEqual(shelfForBookhiveStatus('buzz.bookhive.defs#abandoned'), {
    rkey: 'dnf',
    status: 'dnf',
    name: 'Did Not Finish',
  });
  assert.equal(shelfForBookhiveStatus('buzz.bookhive.defs#unknown'), null);
  assert.equal(shelfForBookhiveStatus(undefined), null);
});

test('normalizeBookhiveBook resolves the catalog subject and edition uri', () => {
  const norm = normalizeBookhiveBook(RECORD);
  assert.equal(norm.subjectUri, bookhiveCatalogUri(HIVE_ID));
  assert.equal(norm.editionUri, bhEditionUri(HIVE_ID));
});

test('normalizeBookhiveBook falls back to hiveId when hiveBookUri is absent', () => {
  const { hiveBookUri: _uris, ...rest } = RECORD;
  assert.equal(normalizeBookhiveBook(rest).subjectUri, bookhiveCatalogUri(HIVE_ID));
});

test('normalizeBookhiveBook ignores a foreign hiveBookUri but keeps hiveId', () => {
  const norm = normalizeBookhiveBook({
    ...RECORD,
    hiveBookUri: 'at://did:plc:other/buzz.bookhive.catalogBook/bk_Wf9C5GP9iEGH6hqNNtwW',
  });
  assert.equal(norm.subjectUri, bookhiveCatalogUri(HIVE_ID));
});

test('normalizeBookhiveBook yields no review for status-only records', () => {
  const norm = normalizeBookhiveBook({ ...RECORD, review: '   ' });
  assert.equal(norm.review, null);
  assert.deepEqual(norm.shelf, { rkey: 'read', status: 'read', name: 'Read' });
});

test('normalizeBookhiveBook clamps out-of-range stars instead of passing them through', () => {
  assert.deepEqual(normalizeBookhiveBook({ ...RECORD, stars: 0 }).review, {
    text: RECORD.review,
    createdAt: RECORD.createdAt,
  });
  assert.deepEqual(normalizeBookhiveBook({ ...RECORD, stars: 11 }).review, {
    text: RECORD.review,
    createdAt: RECORD.createdAt,
  });
  assert.equal(normalizeBookhiveBook({ ...RECORD, stars: 4.5 }).review?.rating, undefined);
});

test('normalizeBookhiveBook tolerates junk input', () => {
  const empty = normalizeBookhiveBook(null);
  assert.deepEqual(empty, { subjectUri: null, editionUri: null, review: null, shelf: null });
  assert.deepEqual(normalizeBookhiveBook({ hiveId: 'nope' }).editionUri, null);
});

test('backlink source is the hiveBookUri path Constellation indexes', () => {
  assert.equal(BOOKHIVE_BACKLINK_SOURCE, 'buzz.bookhive.book:hiveBookUri');
});
