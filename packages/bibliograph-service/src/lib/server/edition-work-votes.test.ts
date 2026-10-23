import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITION_WORK_LINK_COLLECTION,
  consensusThreshold,
  decideConsensus,
  parseEditionWorkVote,
  voteRkeyForEdition,
  type VoteTally,
} from './edition-work-votes';

const EDITION = 'at://did:web:biblio.test/community.lexicon.book.edition/ol.OL1M';
const WORK_A = 'at://did:web:biblio.test/community.lexicon.book.work/ol.W1';
const WORK_B = 'at://did:web:biblio.test/community.lexicon.book.work/ol.W2';

function tally(links: Array<[string, number]>, unlinkCount = 0): VoteTally {
  return {
    links: links.map(([workUri, count]) => ({ workUri, count })),
    unlinkCount,
    ignoredUnknownWork: 0,
  };
}

test('a single link vote does not move the catalog at the default threshold', () => {
  const decision = decideConsensus(tally([[WORK_A, 1]]), null, 2);
  assert.deepEqual(decision, { action: 'none', reason: 'below-threshold' });
});

test('two agreeing link votes apply the link', () => {
  const decision = decideConsensus(tally([[WORK_A, 2]]), null, 2);
  assert.deepEqual(decision, { action: 'link', workUri: WORK_A });
});

test('at threshold 1 a single vote applies, for solo-catalog testing', () => {
  const decision = decideConsensus(tally([[WORK_A, 1]]), null, 1);
  assert.deepEqual(decision, { action: 'link', workUri: WORK_A });
});

test('a competing minority work does not win while outvoted', () => {
  const decision = decideConsensus(tally([[WORK_A, 2], [WORK_B, 1]]), null, 2);
  assert.deepEqual(decision, { action: 'link', workUri: WORK_A });
});

test('link votes are netted against unlink votes', () => {
  // 2 link, 1 unlink -> score 1, below threshold 2: no change.
  assert.deepEqual(decideConsensus(tally([[WORK_A, 2]], 1), WORK_A, 2), {
    action: 'none',
    reason: 'below-threshold',
  });
  // 3 link, 1 unlink -> score 2: applies.
  assert.deepEqual(decideConsensus(tally([[WORK_A, 3]], 1), null, 2), {
    action: 'link',
    workUri: WORK_A,
  });
});

test('enough unlink votes clear an established link', () => {
  assert.deepEqual(decideConsensus(tally([], 2), WORK_A, 2), { action: 'unlink' });
});

test('unlink votes cannot outvote a stronger link majority', () => {
  // Net +1 is not enough for threshold 2: the link holds, but nothing is applied.
  assert.deepEqual(decideConsensus(tally([[WORK_A, 3]], 2), WORK_A, 2), {
    action: 'none',
    reason: 'below-threshold',
  });
  // Net +3 clears it, and the link already points at the winning work.
  assert.deepEqual(decideConsensus(tally([[WORK_A, 5]], 2), WORK_A, 2), {
    action: 'none',
    reason: 'already-satisfied',
  });
});

 test('a stronger majority can replace the currently linked work', () => {
  const decision = decideConsensus(tally([[WORK_B, 2], [WORK_A, 1]]), WORK_A, 2);
  assert.deepEqual(decision, { action: 'link', workUri: WORK_B });

  // Equal counts, current work is one of the tied leaders: hold steady.
  const tied = decideConsensus(tally([[WORK_B, 2], [WORK_A, 2]]), WORK_A, 2);
  assert.deepEqual(tied, { action: 'none', reason: 'already-satisfied' });
});

test('no votes at all is distinguishable from a losing vote', () => {
  assert.deepEqual(decideConsensus(tally([], 0), null, 2), { action: 'none', reason: 'no-votes' });
});

test('threshold falls back to the default on bad input', () => {
  assert.equal(consensusThreshold(undefined), 2);
  assert.equal(consensusThreshold('nope'), 2);
  assert.equal(consensusThreshold('0'), 2);
  assert.equal(consensusThreshold('-3'), 2);
  assert.equal(consensusThreshold('1'), 1);
  assert.equal(consensusThreshold(' 3 '), 3);
});

test('vote rkey is the edition rkey, so one account holds one vote per edition', () => {
  assert.equal(voteRkeyForEdition(EDITION), 'ol.OL1M');
  assert.equal(
    voteRkeyForEdition('at://did:web:biblio.test/community.lexicon.book.edition/gb.fLhiIjDQbcsC'),
    'gb.fLhiIjDQbcsC',
  );
  assert.equal(
    voteRkeyForEdition('at://did:web:biblio.test/community.lexicon.book.edition/isbndb.a-luke-hohmann'),
    'isbndb.a-luke-hohmann',
  );
  // Characters outside the rkey charset are replaced, never passed through.
  assert.equal(voteRkeyForEdition('at://did:web:biblio.test/community.lexicon.book.edition/a b'), 'a-b');
  assert.equal(voteRkeyForEdition('at://did:web:biblio.test/community.lexicon.book.edition/'), 'unknown');
});

test('parse accepts a link vote and normalizes it', () => {
  const vote = parseEditionWorkVote('at://did:plc:voter/x/y', 'did:plc:voter', {
    $type: EDITION_WORK_LINK_COLLECTION,
    edition: { uri: EDITION, cid: 'bafyedition' },
    work: { uri: WORK_A, cid: 'bafywork' },
    action: 'link',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(vote, {
    editionUri: EDITION,
    voterDid: 'did:plc:voter',
    action: 'link',
    workUri: WORK_A,
    workCid: 'bafywork',
    recordUri: 'at://did:plc:voter/x/y',
  });
});

test('parse accepts an unlink vote with no work', () => {
  const vote = parseEditionWorkVote('at://did:plc:voter/x/y', 'did:plc:voter', {
    $type: EDITION_WORK_LINK_COLLECTION,
    edition: { uri: EDITION, cid: 'bafyedition' },
    action: 'unlink',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(vote?.action, 'unlink');
  assert.equal(vote?.workUri, undefined);
});

test('parse rejects malformed votes instead of guessing', () => {
  const base = { $type: EDITION_WORK_LINK_COLLECTION, action: 'link' };
  // A link vote without a work.
  assert.equal(
    parseEditionWorkVote('at://d/x/y', 'd', { ...base, edition: { uri: EDITION } }),
    null,
  );
  // A work URI that is not a work record.
  assert.equal(
    parseEditionWorkVote('at://d/x/y', 'd', {
      ...base,
      edition: { uri: EDITION },
      work: { uri: 'at://did:web:biblio.test/community.lexicon.book.edition/ol.OL1M' },
    }),
    null,
  );
  // An edition URI that is not an edition record.
  assert.equal(
    parseEditionWorkVote('at://d/x/y', 'd', {
      ...base,
      edition: { uri: WORK_A },
      work: { uri: WORK_A },
    }),
    null,
  );
  // Wrong record type and unknown action.
  assert.equal(
    parseEditionWorkVote('at://d/x/y', 'd', {
      $type: 'net.olamaelcu.livtet.biblio.bookShelving',
      edition: { uri: EDITION },
      work: { uri: WORK_A },
      action: 'link',
    }),
    null,
  );
  assert.equal(
    parseEditionWorkVote('at://d/x/y', 'd', {
      $type: EDITION_WORK_LINK_COLLECTION,
      edition: { uri: EDITION },
      work: { uri: WORK_A },
      action: 'delete-everything',
    }),
    null,
  );
});
