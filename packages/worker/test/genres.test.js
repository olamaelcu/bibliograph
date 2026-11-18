import { expect, test } from 'vitest';

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
  expect(canonicalGenre('Fiction')).toBe('Fiction');
  expect(canonicalGenre('Science fiction')).toBe('Science Fiction');
  // A qualifying parenthetical is never part of the genre, and the bare stem is
  // not in the vocabulary, so the label drops out instead of becoming "Dune".
  expect(canonicalGenre('Dune (Imaginary place)')).toBe(undefined);
  expect(canonicalGenre('American literature'), 'a national literature is not a genre').toBe(undefined);
  expect(canonicalGenre('nyt:mass-market-monthly=2021-11-07')).toBe(undefined);
  expect(canonicalGenre('award:nebula_award=novel')).toBe(undefined);
});

test('canonicalGenre reduces an LCSH subdivision to its specific segment', () => {
  expect(canonicalGenre('Fiction, science fiction, general')).toBe('Science Fiction');
  expect(canonicalGenre('Fiction, mystery & detective, general')).toBe('Mystery');
  expect(canonicalGenre('Fiction, romance, general')).toBe('Romance');
  // Longest matching segment wins: "science fiction" carries more than "fiction".
  expect(canonicalGenre('Science fiction, American')).toBe('Science Fiction');
});

test('canonicalGenre normalizes slashes, case and trailing punctuation', () => {
  expect(canonicalGenre('Science Fiction / Fantasy')).toBe('Science Fiction');
  expect(canonicalGenre('Science Fiction / Fantasy')).toBe(canonicalGenre('science fiction'));
  expect(canonicalGenre('  FICTION. ')).toBe('Fiction');
  expect(canonicalGenre('Self-Help;')).toBe('Self Help');
  expect(canonicalGenre('Young Adult Fiction')).toBe('Young Adult');
});

test('canonicalGenre drops format pseudo-genres and non-strings', () => {
  expect(canonicalGenre('Audiobook')).toBe(undefined);
  expect(canonicalGenre('Kindle Edition')).toBe(undefined);
  expect(canonicalGenre('')).toBe(undefined);
  expect(canonicalGenre('   ')).toBe(undefined);
  expect(canonicalGenre(null)).toBe(undefined);
  expect(canonicalGenre(42)).toBe(undefined);
});

test('mergeGenres keeps Goodreads order, appends OpenLibrary alphabetically and dedupes', () => {
  const merged = mergeGenres({
    goodreads: ['Science Fiction', 'Audiobook', 'Classics', 'science fiction'],
    openlibrary: DUNE_SUBJECTS
  });

  expect(merged).toEqual([
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

  expect(merged).toEqual([
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
  expect(merged.length).toBe(MAX_GENRES_PER_EDITION);
  expect(merged[0].name).toBe('Fiction');
  expect(merged.at(-1).name, 'truncation keeps provider order').toBe('History');

  expect(mergeGenres({})).toEqual([]);
  expect(mergeGenres({ goodreads: undefined, openlibrary: undefined })).toEqual([]);
  expect(mergeGenres({ goodreads: ['Audiobook'], openlibrary: ['Unknown heading'] })).toEqual([]);
});
