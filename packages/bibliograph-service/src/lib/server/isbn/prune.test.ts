import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateFromEditionItem,
  editDistance,
  normaliseTitle,
  pruneCandidates,
  scoreCandidate,
  surnameTokens,
  type CandidateBook,
  type TargetEdition,
} from './prune';
import type { EditionItem } from '../search/types';

const TARGET: TargetEdition = {
  title: 'The Dispossessed',
  authors: ['Ursula K. Le Guin'],
  publishedYear: 1974,
};

function candidate(overrides: Partial<CandidateBook> = {}): CandidateBook {
  return {
    source: 'openlibrary',
    title: 'The dispossessed',
    authors: ['Ursula K. Le Guin'],
    publishedYear: 1974,
    isbns: ['9780060512750'],
    ...overrides,
  };
}

test('normaliseTitle drops subtitles, articles, punctuation and accents', () => {
  assert.equal(normaliseTitle('The Dispossessed'), 'dispossessed');
  assert.equal(normaliseTitle('The Dispossessed: An Ambiguous Utopia'), 'dispossessed');
  assert.equal(normaliseTitle('Le Guin — The Dispossessed'), 'le guin the dispossessed');
  assert.equal(normaliseTitle('Brontë: A Life'), 'bronte');
  assert.equal(normaliseTitle('  A   Book  '), 'book');
});

test('surnameTokens keeps the surname and a particle form', () => {
  assert.deepEqual(surnameTokens('Ursula K. Le Guin'), ['guin', 'le guin']);
  assert.deepEqual(surnameTokens('Cathy Park Hong'), ['hong']);
  assert.deepEqual(surnameTokens('Plato'), ['plato']);
  assert.deepEqual(surnameTokens(''), []);
});

test('editDistance stops past its cap', () => {
  assert.equal(editDistance('dispossessed', 'dispossessed'), 0);
  assert.equal(editDistance('dispossessed', 'dispossesed'), 1);
  assert.ok(editDistance('dispossessed', 'something else', 2) > 2);
});

test('a matching candidate is accepted with the exact-title score', () => {
  const scored = scoreCandidate(TARGET, candidate());
  assert.equal(scored.accepted, true);
  assert.equal(scored.score, 4);
  assert.equal(scored.isbn, '9780060512750');
});

test('a near-miss title still passes, at the lower score', () => {
  const scored = scoreCandidate(TARGET, candidate({ title: 'The dispossesed' }));
  assert.equal(scored.accepted, true);
  assert.equal(scored.score, 3);
});

test('a different title is rejected', () => {
  const scored = scoreCandidate(TARGET, candidate({ title: 'The Left Hand of Darkness' }));
  assert.equal(scored.accepted, false);
  assert.equal(scored.reject, 'title_mismatch');
});

test('a shared title by another author is rejected', () => {
  const scored = scoreCandidate(TARGET, candidate({ authors: ['Somebody Else'] }));
  assert.equal(scored.accepted, false);
  assert.equal(scored.reject, 'author_mismatch');
});

test('editions far apart in year are rejected', () => {
  const scored = scoreCandidate(TARGET, candidate({ publishedYear: 1999 }));
  assert.equal(scored.accepted, false);
  assert.match(scored.reject ?? '', /^year_delta_/);
});

test('a one-year difference is tolerated', () => {
  assert.equal(scoreCandidate(TARGET, candidate({ publishedYear: 1975 })).accepted, true);
});

test('a page count that disagrees by more than a tenth is rejected', () => {
  const target: TargetEdition = { ...TARGET, pages: 300 };
  assert.equal(scoreCandidate(target, candidate({ pages: 305 })).accepted, true);
  const off = scoreCandidate(target, candidate({ pages: 400 }));
  assert.equal(off.accepted, false);
  assert.equal(off.reject, 'pages_mismatch');
});

test('a candidate without an ISBN cannot contribute one', () => {
  const scored = scoreCandidate(TARGET, candidate({ isbns: [] }));
  assert.equal(scored.accepted, false);
  assert.equal(scored.reject, 'no_isbn');
});

test('one surviving ISBN is found', () => {
  const pruned = pruneCandidates(TARGET, [
    candidate(),
    candidate({ source: 'googlebooks', title: 'The Left Hand of Darkness' }),
  ]);

  assert.equal(pruned.kind, 'found');
  assert.equal(pruned.isbn, '9780060512750');
  assert.equal(pruned.survivors.length, 1);
  assert.equal(pruned.rejected.length, 1);
});

test('two equally good ISBNs are ambiguous, not a guess', () => {
  const pruned = pruneCandidates(TARGET, [
    candidate(),
    candidate({ source: 'googlebooks', isbns: ['9780060512767'] }),
  ]);

  assert.equal(pruned.kind, 'ambiguous');
  assert.equal(pruned.isbn, undefined);
  assert.equal(pruned.survivors.length, 2);
});

test('a higher-scoring ISBN wins over a near-miss title', () => {
  const pruned = pruneCandidates(TARGET, [
    candidate({ isbns: ['9780060512767'], title: 'The dispossesed' }),
    candidate({ source: 'googlebooks' }),
  ]);

  assert.equal(pruned.kind, 'found');
  assert.equal(pruned.isbn, '9780060512750');
});

test('nothing surviving is none', () => {
  const pruned = pruneCandidates(TARGET, [candidate({ authors: ['Nobody'] })]);
  assert.equal(pruned.kind, 'none');
  assert.equal(pruned.rejected.length, 1);
  assert.equal(pruned.survivors.length, 0);
});

test('candidateFromEditionItem reads contributors, year and ISBNs', () => {
  const item: EditionItem = {
    uri: 'at://did:web:biblio/community.lexicon.book.edition/ol.OL1M',
    title: 'The Dispossessed',
    publishedYear: 1974,
    contributors: [{ subject: { uri: 'at://author/1', cid: 'bafy' }, role: 'author' }],
    identifiers: [
      { uri: 'https://openlibrary.org/books/OL1M', resource: 'openlibrary' },
      { uri: 'isbn:9780060512750', resource: 'isbn13' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const itemNames = new Map([['at://author/1', 'Ursula K. Le Guin']]);
  const candidate = candidateFromEditionItem('openlibrary', item, itemNames);

  assert.equal(candidate.title, 'The Dispossessed');
  assert.deepEqual(candidate.authors, ['Ursula K. Le Guin']);
  assert.equal(candidate.publishedYear, 1974);
  assert.deepEqual(candidate.isbns, ['9780060512750']);
});

test('a target with no author names can never accept a candidate', () => {
  const scored = scoreCandidate({ ...TARGET, authors: [] }, candidate());
  assert.equal(scored.accepted, false);
  assert.equal(scored.reject, 'author_unknown');
});
