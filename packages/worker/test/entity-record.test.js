import { expect, test } from 'vitest';

import {
  EntityRecordError,
  buildContributorRecord,
  buildPublisherRecord
} from '../lib/entity-record.js';
import { isoCalendarDate } from '../lib/record-fields.js';

const CREATED_AT = new Date('2026-11-12T10:20:30.000Z');

function contributor(overrides = {}) {
  return {
    at_uri: 'at://did:plc:publisher/net.olamaelcu.livtet.biblio.contributor/3abc',
    name: 'Ursula K. Le Guin',
    name_inverted: 'Le Guin, Ursula K.',
    description: 'An American author.',
    image_url: 'https://example.org/ursula.jpg',
    born: '1929-10-21',
    died: '2018-01-22',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    created_at: CREATED_AT,
    ...overrides
  };
}

function publisher(overrides = {}) {
  return {
    at_uri: 'at://did:plc:publisher/net.olamaelcu.livtet.biblio.publisher/3def',
    name: 'Ace Books',
    description: 'A science-fiction imprint.',
    image_url: 'https://example.org/ace.png',
    started: '1952-01-01',
    ended: '2019-12-31',
    identifiers: [{ issuer: 'isni', value: '0000000121032683' }],
    created_at: CREATED_AT,
    ...overrides
  };
}

test('builds the full contributor record', () => {
  expect(buildContributorRecord({ contributor: contributor() })).toEqual({
    displayName: 'Ursula K. Le Guin',
    nameInverted: 'Le Guin, Ursula K.',
    description: 'An American author.',
    imageUrl: 'https://example.org/ursula.jpg',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    born: '1929-10-21',
    died: '2018-01-22',
    createdAt: '2026-11-12T10:20:30.000Z'
  });
});

test('omits empty optional contributor fields', () => {
  const record = buildContributorRecord({
    contributor: contributor({
      name_inverted: null,
      description: '   ',
      image_url: '',
      born: null,
      died: null,
      identifiers: []
    })
  });
  expect(record).toEqual({
    displayName: 'Ursula K. Le Guin',
    createdAt: '2026-11-12T10:20:30.000Z'
  });
});

test('canonicalizes identifiers: dedupes pairs and sorts by issuer then value', () => {
  const record = buildContributorRecord({
    contributor: contributor({
      identifiers: [
        { issuer: 'viaf', value: '2' },
        { issuer: 'orcid', value: '1' },
        { issuer: 'viaf', value: '2', url: 'https://viaf.example/2' },
        { issuer: '', value: 'nope' },
        { issuer: 'viaf', value: '' }
      ]
    })
  });
  expect(record.identifiers).toEqual([
    { issuer: 'orcid', value: '1' },
    { issuer: 'viaf', value: '2' }
  ]);
});

test('rejects a partial, malformed or impossible contributor date', () => {
  for (const bad of ['1929', '1929-10', '1929-1-21', '1929-13-01', '1929-00-01', '2023-02-29']) {
    expect(thrownBy(() => buildContributorRecord({ contributor: contributor({ born: bad }) })), `expected ${bad} to be rejected`).toSatisfy((error) => error instanceof EntityRecordError && /born/.test(error.message));
  }
});

test('accepts a real leap day and year boundaries', () => {
  expect(isoCalendarDate('2024-02-29')).toBe('2024-02-29');
  expect(isoCalendarDate('0001-01-01')).toBe('0001-01-01');
  expect(isoCalendarDate('9999-12-31')).toBe('9999-12-31');
});

test('rejects a non-http image URL', () => {
  for (const bad of ['ftp://example.org/a.jpg', 'javascript:alert(1)', 'not a url']) {
    expect(thrownBy(() => buildContributorRecord({ contributor: contributor({ image_url: bad }) })), `expected ${bad} to be rejected`).toSatisfy((error) => error instanceof EntityRecordError && /image_url/.test(error.message));
  }
});

test('requires a display name and a created_at', () => {
  expect(thrownBy(() => buildContributorRecord({ contributor: contributor({ name: '  ' }) }))).toSatisfy((error) => error instanceof EntityRecordError && /display name/.test(error.message));
  expect(thrownBy(() => buildContributorRecord({ contributor: contributor({ created_at: 'not a date' }) }))).toSatisfy((error) => error instanceof EntityRecordError && /created_at/.test(error.message));
});

test('builds the full publisher record', () => {
  expect(buildPublisherRecord({ publisher: publisher() })).toEqual({
    name: 'Ace Books',
    description: 'A science-fiction imprint.',
    imageUrl: 'https://example.org/ace.png',
    identifiers: [{ issuer: 'isni', value: '0000000121032683' }],
    started: '1952-01-01',
    ended: '2019-12-31',
    createdAt: '2026-11-12T10:20:30.000Z'
  });
});

test('rejects an impossible publisher date and requires a name', () => {
  expect(thrownBy(() => buildPublisherRecord({ publisher: publisher({ started: '1952-02-30' }) }))).toSatisfy((error) => error instanceof EntityRecordError && /started/.test(error.message));
  expect(thrownBy(() => buildPublisherRecord({ publisher: publisher({ name: '' }) }))).toSatisfy((error) => error instanceof EntityRecordError && /has no name/.test(error.message));
});

/** vitest has no predicate form of toThrow: capture the throw and assert on it. */
function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
