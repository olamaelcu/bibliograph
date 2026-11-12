import test from 'node:test';
import assert from 'node:assert/strict';

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
  assert.deepEqual(buildContributorRecord({ contributor: contributor() }), {
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
  assert.deepEqual(record, {
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
  assert.deepEqual(record.identifiers, [
    { issuer: 'orcid', value: '1' },
    { issuer: 'viaf', value: '2' }
  ]);
});

test('rejects a partial, malformed or impossible contributor date', () => {
  for (const bad of ['1929', '1929-10', '1929-1-21', '1929-13-01', '1929-00-01', '2023-02-29']) {
    assert.throws(
      () => buildContributorRecord({ contributor: contributor({ born: bad }) }),
      (error) => error instanceof EntityRecordError && /born/.test(error.message),
      `expected ${bad} to be rejected`
    );
  }
});

test('accepts a real leap day and year boundaries', () => {
  assert.equal(isoCalendarDate('2024-02-29'), '2024-02-29');
  assert.equal(isoCalendarDate('0001-01-01'), '0001-01-01');
  assert.equal(isoCalendarDate('9999-12-31'), '9999-12-31');
});

test('rejects a non-http image URL', () => {
  for (const bad of ['ftp://example.org/a.jpg', 'javascript:alert(1)', 'not a url']) {
    assert.throws(
      () => buildContributorRecord({ contributor: contributor({ image_url: bad }) }),
      (error) => error instanceof EntityRecordError && /image_url/.test(error.message),
      `expected ${bad} to be rejected`
    );
  }
});

test('requires a display name and a created_at', () => {
  assert.throws(
    () => buildContributorRecord({ contributor: contributor({ name: '  ' }) }),
    (error) => error instanceof EntityRecordError && /display name/.test(error.message)
  );
  assert.throws(
    () => buildContributorRecord({ contributor: contributor({ created_at: 'not a date' }) }),
    (error) => error instanceof EntityRecordError && /created_at/.test(error.message)
  );
});

test('builds the full publisher record', () => {
  assert.deepEqual(buildPublisherRecord({ publisher: publisher() }), {
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
  assert.throws(
    () => buildPublisherRecord({ publisher: publisher({ started: '1952-02-30' }) }),
    (error) => error instanceof EntityRecordError && /started/.test(error.message)
  );
  assert.throws(
    () => buildPublisherRecord({ publisher: publisher({ name: '' }) }),
    (error) => error instanceof EntityRecordError && /has no name/.test(error.message)
  );
});
