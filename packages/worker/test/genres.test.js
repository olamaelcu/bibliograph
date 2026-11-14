import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalGenre, mergeGenres, MAX_GENRES_PER_EDITION } from '../lib/genres.js';

// The real subject list OpenLibrary answers for the work behind
// `isbn/9780441013593`: LCSH headings, a subdivision form, and program tags.
const DUNE_SUBJECTS = [
  'Dune (Imaginary place)',
  'Fiction',
  'American literature',
  'Fiction, science fiction, general',
  'Science fiction',
  'Science fiction, American',
  'nyt:mass-market-monthly=2021-11-07',
  'award:nebula_award=novel'
];

test('canonicalGenre maps real OpenLibrary subjects and drops the noise', () => {
  assert.equal(canonicalGenre('Fiction'), 'Fiction');
  assert.equal(canonicalGenre('Science fiction'), 'Science Fiction');
  // A qualifying parenthetical is never part of the genre, and the bare stem is
  // not in the vocabulary, so the label drops out instead of becoming "Dune".
  assert.equal(canonicalGenre('Dune (Imaginary place)'), undefined);
  assert.equal(canonicalGenre('American literature'), undefined, 'a national literature is not a genre');
  assert.equal(canonicalGenre('nyt:mass-market-monthly=2021-11-07'), undefined);
  assert.equal(canonicalGenre('award:nebula_award=novel'), undefined);
});

test('canonicalGenre reduces an LCSH subdivision to its specific segment', () => {
  assert.equal(canonicalGenre('Fiction, science fiction, general'), 'Science Fiction');
  assert.equal(canonicalGenre('Fiction, mystery & detective, general'), 'Mystery');
  assert.equal(canonicalGenre('Fiction, romance, general'), 'Romance');
  // Longest matching segment wins: "science fiction" carries more than "fiction".
  assert.equal(canonicalGenre('Science fiction, American'), 'Science Fiction');
});

test('canonicalGenre normalizes slashes, case and trailing punctuation', () => {
  assert.equal(canonicalGenre('Science Fiction / Fantasy'), 'Science Fiction');
  assert.equal(canonicalGenre('Science Fiction / Fantasy'), canonicalGenre('science fiction'));
  assert.equal(canonicalGenre('  FICTION. '), 'Fiction');
  assert.equal(canonicalGenre('Self-Help;'), 'Self Help');
  assert.equal(canonicalGenre('Young Adult Fiction'), 'Young Adult');
});

test('canonicalGenre drops format pseudo-genres and non-strings', () => {
  assert.equal(canonicalGenre('Audiobook'), undefined);
  assert.equal(canonicalGenre('Kindle Edition'), undefined);
  assert.equal(canonicalGenre(''), undefined);
  assert.equal(canonicalGenre('   '), undefined);
  assert.equal(canonicalGenre(null), undefined);
  assert.equal(canonicalGenre(42), undefined);
});

test('mergeGenres keeps Goodreads order, appends OpenLibrary alphabetically and dedupes', () => {
  const merged = mergeGenres({
    goodreads: ['Science Fiction', 'Audiobook', 'Classics', 'science fiction'],
    openlibrary: DUNE_SUBJECTS
  });

  assert.deepEqual(merged, [
    // Goodreads order first; the duplicate and the format tag drop out.
    { name: 'Science Fiction', source: 'goodreads' },
    { name: 'Classics', source: 'goodreads' },
    // Then the surviving OpenLibrary names, alphabetical, minus Science Fiction.
    { name: 'Fiction', source: 'openlibrary' }
  ]);
});

test('mergeGenres appends ISBNdb subjects last, alphabetically, deduped', () => {
  const merged = mergeGenres({
    goodreads: ['Science Fiction'],
    openlibrary: ['Fiction'],
    isbndb: ['Poetry', 'classics', 'Fiction', 'Textbooks']
  });

  assert.deepEqual(merged, [
    { name: 'Science Fiction', source: 'goodreads' },
    { name: 'Fiction', source: 'openlibrary' },
    { name: 'Classics', source: 'isbndb' },
    { name: 'Poetry', source: 'isbndb' }
  ]);
});

test('mergeGenres caps the list and tolerates missing inputs', () => {
  const many = [
    'fiction',
    'fantasy',
    'mystery',
    'crime',
    'thriller',
    'horror',
    'romance',
    'classics',
    'poetry',
    'drama',
    'satire',
    'history',
    'biography',
    'travel'
  ];
  const merged = mergeGenres({ goodreads: many });
  assert.equal(merged.length, MAX_GENRES_PER_EDITION);
  assert.equal(merged[0].name, 'Fiction');
  assert.equal(merged.at(-1).name, 'History', 'truncation keeps provider order');

  assert.deepEqual(mergeGenres({}), []);
  assert.deepEqual(mergeGenres({ goodreads: undefined, openlibrary: undefined }), []);
  assert.deepEqual(mergeGenres({ goodreads: ['Audiobook'], openlibrary: ['Unknown heading'] }), []);
});
