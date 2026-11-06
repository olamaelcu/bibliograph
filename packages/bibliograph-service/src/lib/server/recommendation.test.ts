import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOMMENDATION_LIMIT,
  mergeRecommendations,
  type RecommendationHit,
} from './recommendation';

const URI = 'at://did:web:biblio.test/community.lexicon.book.edition';

function hit(
  rkey: string,
  tid: string,
  overlap: number,
  hasCover = true,
): RecommendationHit {
  return { uri: `${URI}/${rkey}`, tid, overlap, hasCover };
}

const EXCLUDED = new Set<string>();
const NO_URIS = new Set<string>();

test('caps the page at the recommendation limit', () => {
  const many = Array.from({ length: RECOMMENDATION_LIMIT + 12 }, (_, index) =>
    hit(`gb.${index}`, `tid${index}`, 5 - (index % 5)),
  );
  const page = mergeRecommendations({
    active: many,
    past: [],
    excludedTids: EXCLUDED,
    excludedUris: NO_URIS,
    limit: 100,
  });
  assert.equal(page.length, RECOMMENDATION_LIMIT);
});

test('honours a smaller page size without reordering', () => {
  const page = mergeRecommendations({
    active: [hit('gb.a', 'tidA', 3), hit('gb.b', 'tidB', 2), hit('gb.c', 'tidC', 1)],
    past: [],
    excludedTids: EXCLUDED,
    excludedUris: NO_URIS,
    limit: 2,
  });
  assert.deepEqual(page, [`${URI}/gb.a`, `${URI}/gb.b`]);
});

test('surfaces active reads before past reads', () => {
  const page = mergeRecommendations({
    active: [hit('gb.now', 'tidNow', 1)],
    past: [hit('gb.before', 'tidBefore', 9)],
    excludedTids: EXCLUDED,
    excludedUris: NO_URIS,
    limit: 10,
  });
  assert.deepEqual(page, [`${URI}/gb.now`, `${URI}/gb.before`]);
});

test('returns a book reachable from both lists once, at its active position', () => {
  const page = mergeRecommendations({
    active: [hit('gb.a', 'tidA', 2), hit('gb.b', 'tidB', 1)],
    past: [hit('gb.a2', 'tidA', 4), hit('gb.c', 'tidC', 1)],
    excludedTids: EXCLUDED,
    excludedUris: NO_URIS,
    limit: 10,
  });
  // tidA keeps the active edition; the past-list alias is the same book.
  assert.deepEqual(page, [`${URI}/gb.a`, `${URI}/gb.b`, `${URI}/gb.c`]);
});

test('never recommends a book the reader already has', () => {
  const page = mergeRecommendations({
    active: [hit('gb.shelved', 'tidShelved', 5), hit('gb.fresh', 'tidFresh', 1)],
    past: [hit('gb.reviewed', 'tidReviewed', 2)],
    excludedTids: new Set(['tidShelved', 'tidReviewed']),
    excludedUris: NO_URIS,
    limit: 10,
  });
  assert.deepEqual(page, [`${URI}/gb.fresh`]);
});

test('drops a candidate whose uri the reader already has under another tid', () => {
  const page = mergeRecommendations({
    active: [hit('gb.a', 'tidA', 3), hit('gb.b', 'tidB', 2)],
    past: [],
    excludedTids: EXCLUDED,
    excludedUris: new Set([`${URI}/gb.a`]),
    limit: 10,
  });
  assert.deepEqual(page, [`${URI}/gb.b`]);
});

test('prefers the edition that has a cover for the same book', () => {
  const page = mergeRecommendations({
    active: [hit('gb.bare', 'tidA', 3, false)],
    past: [hit('gb.covered', 'tidA', 2, true)],
    excludedTids: EXCLUDED,
    excludedUris: NO_URIS,
    limit: 10,
  });
  assert.deepEqual(page, [`${URI}/gb.covered`]);
});

test('a later edition without a cover does not displace the covered one', () => {
  const page = mergeRecommendations({
    active: [hit('gb.covered', 'tidA', 3, true)],
    past: [hit('gb.bare', 'tidA', 2, false)],
    excludedTids: EXCLUDED,
    excludedUris: NO_URIS,
    limit: 10,
  });
  assert.deepEqual(page, [`${URI}/gb.covered`]);
});

test('a library with nothing to recommend yields nothing', () => {
  assert.deepEqual(
    mergeRecommendations({
      active: [],
      past: [],
      excludedTids: EXCLUDED,
      excludedUris: NO_URIS,
      limit: 30,
    }),
    [],
  );
});
