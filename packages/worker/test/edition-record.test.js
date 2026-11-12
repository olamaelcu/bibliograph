import test from 'node:test';
import assert from 'node:assert/strict';

import { EditionRecordError, buildEditionRecord } from '../lib/edition-record.js';

const edition = {
  uri: 'at://did:web:test.example/community.lexicon.media.book.edition/3n22xzi7cyz23',
  title: 'The Left Hand of Darkness',
  subtitle: 'A Novel',
  language: 'en',
  published_date: '1969',
  format: 'physical',
  pages: 304,
  duration_seconds: null,
  chapters: 21,
  series: { name: 'Hainish Cycle', position: '4', display: 'Vol. IV' },
  book_edition: '2nd revised',
  description: 'A novel of the Ekumen.',
  cover_url: 'https://covers.example/9780441478125.jpg',
  created_at: new Date('2026-01-02T03:04:05.000Z')
};

const identifiers = [
  { issuer: 'googlebooks', value: 'efdyneVzATwC' },
  { issuer: 'isbn13', value: '9780441478125' }
];

const contributors = [
  {
    name: 'Ursula K. Le Guin',
    role: 'author',
    identifiers: [{ issuer: 'viaf', value: '123456' }],
    ref: 'at://did:plc:example/app.bsky.actor.profile/self'
  },
  { name: 'C. J. Cherryh', role: 'foreword', identifiers: [], ref: null }
];

const publisher = {
  name: 'Ace Books',
  identifiers: [{ issuer: 'wikidata', value: 'Q1234' }]
};

test('builds the lexicon record from catalog rows', () => {
  const record = buildEditionRecord({ edition, identifiers, contributors, publisher });

  assert.deepEqual(record, {
    title: 'The Left Hand of Darkness',
    identifiers: [
      { issuer: 'googlebooks', value: 'efdyneVzATwC' },
      { issuer: 'isbn13', value: '9780441478125' }
    ],
    contributors: [
      {
        displayName: 'Ursula K. Le Guin',
        role: 'A01',
        identifiers: [{ issuer: 'viaf', value: '123456' }],
        ref: 'at://did:plc:example/app.bsky.actor.profile/self'
      },
      { displayName: 'C. J. Cherryh', role: 'A23' }
    ],
    createdAt: '2026-01-02T03:04:05.000Z',
    subtitle: 'A Novel',
    language: 'en',
    publishedDate: '1969',
    publisher: { name: 'Ace Books', identifiers: [{ issuer: 'wikidata', value: 'Q1234' }] },
    format: 'physical',
    pages: 304,
    chapters: 21,
    series: { name: 'Hainish Cycle', position: '4', display: 'Vol. IV' },
    bookEdition: '2nd revised',
    description: 'A novel of the Ekumen.',
    coverUrl: 'https://covers.example/9780441478125.jpg'
  });

  // coverUrl is URL-only; the record must never carry a blob field.
  assert.equal('cover' in record, false);
  assert.equal('durationSeconds' in record, false);
});

test('omits empty optional fields and deduplicates identifiers', () => {
  const record = buildEditionRecord({
    edition: {
      uri: edition.uri,
      title: 'Minimal',
      subtitle: '  ',
      language: null,
      published_date: '',
      format: undefined,
      pages: -1,
      duration_seconds: null,
      chapters: null,
      series: { name: '' },
      book_edition: null,
      description: '',
      cover_url: 'not a url',
      created_at: '2026-05-06T07:08:09Z'
    },
    identifiers: [
      { issuer: 'isbn13', value: '9780000000001' },
      { issuer: 'isbn13', value: '9780000000001' },
      { issuer: '', value: 'ignored' }
    ],
    contributors: [{ name: '', role: 'author' }],
    publisher: { name: '' }
  });

  assert.deepEqual(record, {
    title: 'Minimal',
    identifiers: [{ issuer: 'isbn13', value: '9780000000001' }],
    contributors: [],
    createdAt: '2026-05-06T07:08:09.000Z'
  });
});

test('refuses a record with no identifiers', () => {
  assert.throws(
    () => buildEditionRecord({ edition, identifiers: [], contributors: [], publisher }),
    (error) => error instanceof EditionRecordError && /no identifiers/.test(error.message)
  );
});

test('refuses a record with no title or created_at', () => {
  assert.throws(
    () => buildEditionRecord({ edition: { ...edition, title: ' ' }, identifiers }),
    /no title/
  );
  assert.throws(
    () => buildEditionRecord({ edition: { ...edition, created_at: 'not-a-date' }, identifiers }),
    /created_at/
  );
});

test('accepts ONIX codes and nameInverted from catalog rows', () => {
  const record = buildEditionRecord({
    edition,
    identifiers,
    contributors: [
      {
        name: 'Ursula K. Le Guin',
        name_inverted: 'Le Guin, Ursula K.',
        role: 'B06'
      }
    ]
  });

  assert.deepEqual(record.contributors, [
    { displayName: 'Ursula K. Le Guin', nameInverted: 'Le Guin, Ursula K.', role: 'B06' }
  ]);
});

test('defaults a missing contributor role to A01', () => {
  const record = buildEditionRecord({
    edition,
    identifiers,
    contributors: [{ name: 'Anonymous' }]
  });

  assert.deepEqual(record.contributors, [{ displayName: 'Anonymous', role: 'A01' }]);
});
