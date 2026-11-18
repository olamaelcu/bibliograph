/**
 * `lookupIsbn`: which providers are asked, in what order, and which candidate
 * the title rule accepts.
 *
 * The providers are fakes, so the assertions are about the picker and the call
 * order — the two things a sweep over a hundred thousand books depends on.
 */

import { expect, test } from 'vitest';

import {
  isbnFromCandidate,
  isbn10FromIsbn13,
  lookupIsbn,
  normaliseTitle,
  rankTitleMatches,
  titleOverlap,
  titleForLookup,
  titlesMatch
} from '../lib/providers/isbn-lookup.js';

const log = { info() {}, warn() {}, error() {} };

function isbnCandidate(title, isbn13, extra = {}) {
  return { title, identifiers: [{ issuer: 'isbn13', value: isbn13 }], ...extra };
}

function fakeProviders({ openlibrary, goodreads, goodreadsPage, google } = {}) {
  const calls = { openlibrary: 0, goodreads: 0, goodreadsPages: [], google: 0, isbndb: 0 };
  const answer = (value) => async () => {
    // Re-answer the same array without letting a test mutate shared state.
    const result = typeof value === 'function' ? value() : value ?? [];
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    calls,
    providers: {
      openlibrary: {
        search: async () => {
          calls.openlibrary += 1;
          return answer(openlibrary)();
        }
      },
      goodreads: {
        search: async (text) => {
          calls.goodreads += 1;
          calls.goodreadsQuery = text;
          return answer(goodreads)();
        },
        byId: async (id) => {
          calls.goodreadsPages.push(id);
          return answer(goodreadsPage)();
        }
      },
      google: {
        search: async () => {
          calls.google += 1;
          return answer(google)();
        }
      },
      // Must never be asked: the whole point of this lookup is that the
      // metered provider stays out of a 100k-book sweep.
      isbndb: {
        search: async () => {
          calls.isbndb += 1;
          throw new Error('isbndb must not be called');
        },
        byIsbn: async () => {
          calls.isbndb += 1;
          throw new Error('isbndb must not be called');
        }
      }
    }
  };
}

test('titles normalise case, punctuation and diacritics before they are compared', () => {
  expect(normaliseTitle('  The Left Hand   of Darkness! ')).toBe('the left hand of darkness');
  expect(normaliseTitle('Café Society')).toBe('cafe society');
  expect(titlesMatch('Café Society', 'cafe society.')).toBe(true);
});

test('an exact title matches on both sides of the rule', () => {
  expect(titlesMatch('The Left Hand of Darkness', 'the left hand of darkness')).toBe(true);
});

test('a near title matches when the opening and the tokens agree', () => {
  // A subtitle, a series suffix and a missing leading article are the near
  // matches providers actually return.
  expect(titlesMatch('Neuromancer', 'Neuromancer: A Novel')).toBe(true);
  expect(titlesMatch('The Hobbit', 'The Hobbit, or There and Back Again')).toBe(true);
  expect(titlesMatch('Roadside Picnic', 'Roadside Picnic (Rediscovered Classics)')).toBe(true);
});

test('a different book sharing the first twenty characters is rejected', () => {
  // Both titles open with "harry potter and the"; only the token share tells
  // them apart (4 of 6 reference tokens), which is why both tests are required.
  expect(
    titlesMatch(
      "Harry Potter and the Philosopher's Stone",
      'Harry Potter and the Chamber of Secrets'
    )
  ).toBe(false);
  expect(titlesMatch('The Great Gatsby', "Gatsby's Dream")).toBe(false);
});

test('overlap is measured against the reference title, not the union', () => {
  expect(titleOverlap('Dune', 'Dune Messiah')).toBe(1);
  expect(titleOverlap('Dune Messiah', 'Dune')).toBe(0.5);
});

test('the best match is the exact title, then the greatest overlap', () => {
  const ranked = rankTitleMatches('Dune', [
    isbnCandidate('Dune Messiah', '9780000000002'),
    isbnCandidate('Dune', '9780000000003'),
    isbnCandidate('Dune (Dune Chronicles, #1)', '9780000000004')
  ]);
  expect(ranked.map((candidate) => candidate.title)).toEqual([
    'Dune',
    // Both near titles repeat the one reference token; nothing else separates
    // them, so the shorter title (the one carrying the least extra text) wins.
    'Dune Messiah',
    'Dune (Dune Chronicles, #1)'
  ]);
});

test('OpenLibrary answers first and the metered provider is never asked', async () => {
  const { providers, calls } = fakeProviders({
    openlibrary: [isbnCandidate('The Left Hand of Darkness', '9780441478125')],
    google: [isbnCandidate('The Left Hand of Darkness', '9780000000009')]
  });

  const found = await lookupIsbn({ providers, title: 'The Left Hand of Darkness', logger: log });

  expect(found?.isbn13).toBe('9780441478125');
  expect(found?.source).toBe('openlibrary');
  expect(calls.goodreads, 'a later provider is not asked once one answered').toBe(0);
  expect(calls.google).toBe(0);
  expect(calls.isbndb).toBe(0);
});

test('Goodreads is asked second and its book page supplies the ISBN', async () => {
  // A Goodreads search row carries the numeric id and no ISBN.
  const { providers, calls } = fakeProviders({
    openlibrary: [],
    goodreads: [
      { title: 'Roadside Picnic', identifiers: [{ issuer: 'goodreads', value: '123' }] },
      { title: 'Unrelated Book', identifiers: [{ issuer: 'goodreads', value: '456' }] }
    ],
    goodreadsPage: [isbnCandidate('Roadside Picnic', '9781613743416')],
    google: [isbnCandidate('Roadside Picnic', '9780000000011')]
  });

  const found = await lookupIsbn({ providers, title: 'Roadside Picnic', authors: ['Arkady Strugatsky'], logger: log });

  expect(found?.isbn13).toBe('9781613743416');
  expect(found?.source).toBe('goodreads');
  expect(calls.goodreadsPages, 'only the matched search row is opened').toEqual(['123']);
  expect(calls.goodreadsQuery, 'the query carries the author too').toBe(
    'Roadside Picnic Arkady Strugatsky'
  );
  expect(calls.google).toBe(0);
  expect(calls.isbndb).toBe(0);
});

test('Google Books is the last step, and a failed free provider does not sink the lookup', async () => {
  const { providers, calls } = fakeProviders({
    openlibrary: new Error('openlibrary down'),
    goodreads: [],
    google: [isbnCandidate('The Left Hand of Darkness', '9780441478125')]
  });

  const found = await lookupIsbn({ providers, title: 'The Left Hand of Darkness', logger: log });

  expect(found?.source).toBe('googlebooks');
  expect(calls.openlibrary).toBe(1);
  expect(calls.goodreads).toBe(1);
  expect(calls.google).toBe(1);
});

test('a candidate that does not pass the title rule is never attached', async () => {
  const { providers } = fakeProviders({
    openlibrary: [isbnCandidate("Harry Potter and the Chamber of Secrets", '9780439064873')],
    goodreads: [],
    google: []
  });

  expect(
    await lookupIsbn({ providers, title: "Harry Potter and the Philosopher's Stone", logger: log })
  ).toBeNull();
});

test('every provider failing rethrows so the job retries instead of filing an absence', async () => {
  const { providers } = fakeProviders({
    openlibrary: new Error('openlibrary down'),
    goodreads: new Error('goodreads challenge'),
    google: new Error('google quota')
  });

  await expect(
    lookupIsbn({ providers, title: 'Roadside Picnic', logger: log })
  ).rejects.toThrow('openlibrary down');
});

test('an ISBN-10 identifier is normalised to thirteen digits', () => {
  expect(
    isbnFromCandidate({
      identifiers: [{ issuer: 'isbn10', value: '0441478123' }]
    })
  ).toBe('9780441478125');
});

test('a 978 ISBN-13 has an ISBN-10 form, a 979 one does not', () => {
  expect(isbn10FromIsbn13('9780553293357')).toBe('0553293354');
  expect(isbn10FromIsbn13('9791090636071')).toBeNull();
  expect(isbn10FromIsbn13('not an isbn')).toBeNull();
});

test('the lookup title drops an author or series suffix but keeps an edition note', () => {
  expect(titleForLookup('Neuromancer - William Gibson')).toBe('Neuromancer');
  expect(titleForLookup('The Left Hand of Darkness by Ursula K. Le Guin')).toBe(
    'The Left Hand of Darkness'
  );
  expect(titleForLookup('Dune (Dune Chronicles, #1)')).toBe('Dune');
  // A format or series suffix is part of what names the edition: dropping it
  // would let the base edition's ISBN attach to a deluxe one.
  expect(titleForLookup('Dune - Deluxe Edition')).toBe('Dune - Deluxe Edition');
  expect(titleForLookup('Dune - Book 2')).toBe('Dune - Book 2');
  expect(titleForLookup("Harry Potter and the Philosopher's Stone")).toBe(
    "Harry Potter and the Philosopher's Stone"
  );
});

test('a dirty catalog title resolves through the cleaned query', async () => {
  const offered = [isbnCandidate('Neuromancer', '9780441569595')];
  const providers = {
    openlibrary: { search: async () => offered },
    goodreads: { search: async () => [] },
    google: { search: async () => [] }
  };

  const found = await lookupIsbn({
    providers,
    title: 'Neuromancer - William Gibson',
    logger: log
  });

  expect(found?.isbn13).toBe('9780441569595');
  expect(found?.source).toBe('openlibrary');
});
