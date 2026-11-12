import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENTITY_EDIT_LIMITS,
  parseEntityEdit,
  strictCalendarDate
} from '../src/lib/admin/entity-edit.ts';

function paths(kind: 'contributor' | 'publisher', body: unknown): string[] {
  return parseEntityEdit(kind, body).errors.map((issue) => issue.path);
}

const contributor = () => ({ name: 'Frank Herbert' });
const publisher = () => ({ name: 'Ace Books' });

test('accepts a minimal contributor and normalises optional fields', () => {
  const parsed = parseEntityEdit('contributor', contributor());
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.value);
  assert.equal(parsed.value.name, 'Frank Herbert');
  assert.equal(parsed.value.nameInverted, null);
  assert.deepEqual(parsed.value.identifiers, []);
  assert.equal(parsed.value.description, null);
  assert.equal(parsed.value.imageUrl, null);
  assert.equal(parsed.value.born, null);
  assert.equal(parsed.value.died, null);
  assert.equal(parsed.value.expectedRevision, null);
});

test('accepts a minimal publisher and keeps only publisher date fields', () => {
  const parsed = parseEntityEdit('publisher', {
    ...publisher(),
    started: '1972-01-01',
    ended: '1998-12-31',
    born: 'not a date'
  });
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.value);
  assert.equal(parsed.value.name, 'Ace Books');
  assert.deepEqual(parsed.value.identifiers, []);
  assert.equal(parsed.value.started, '1972-01-01');
  assert.equal(parsed.value.ended, '1998-12-31');
  assert.equal('born' in parsed.value, false);
});

test('trims the name and inverted name', () => {
  const parsed = parseEntityEdit('contributor', {
    name: '  Frank Herbert  ',
    nameInverted: '  Herbert, Frank  '
  });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.value?.name, 'Frank Herbert');
  assert.equal(parsed.value?.nameInverted, 'Herbert, Frank');
});

test('requires a bounded, non-blank name', () => {
  for (const body of [{}, { name: null }, { name: '   ' }, { name: 42 }]) {
    assert.ok(paths('contributor', body).includes('name'), JSON.stringify(body));
    assert.ok(paths('publisher', body).includes('name'), JSON.stringify(body));
  }
  assert.ok(
    paths('contributor', { name: 'x'.repeat(ENTITY_EDIT_LIMITS.name + 1) }).includes('name')
  );
  assert.deepEqual(paths('contributor', { name: 'x'.repeat(ENTITY_EDIT_LIMITS.name) }), []);
});

test('bounds the inverted name and description', () => {
  assert.ok(
    paths('contributor', {
      ...contributor(),
      nameInverted: 'x'.repeat(ENTITY_EDIT_LIMITS.nameInverted + 1)
    }).includes('nameInverted')
  );
  assert.ok(
    paths('publisher', {
      ...publisher(),
      description: 'x'.repeat(ENTITY_EDIT_LIMITS.description + 1)
    }).includes('description')
  );
  assert.deepEqual(
    paths('publisher', {
      ...publisher(),
      description: 'x'.repeat(ENTITY_EDIT_LIMITS.description)
    }),
    []
  );
});

test('accepts unique identifier pairs and rejects empty or duplicate ones', () => {
  const parsed = parseEntityEdit('contributor', {
    ...contributor(),
    identifiers: [
      { issuer: 'isni', value: '0000000123456789' },
      { issuer: 'viaf', value: '123456' }
    ]
  });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.value?.identifiers, [
    { issuer: 'isni', value: '0000000123456789' },
    { issuer: 'viaf', value: '123456' }
  ]);

  const duplicate = paths('contributor', {
    ...contributor(),
    identifiers: [
      { issuer: 'isni', value: '1' },
      { issuer: 'isni', value: '1' }
    ]
  });
  assert.ok(duplicate.includes('identifiers.1'));

  const empty = paths('contributor', {
    ...contributor(),
    identifiers: [
      { issuer: ' ', value: '1' },
      { issuer: 'isni', value: ' ' }
    ]
  });
  assert.ok(empty.includes('identifiers.0.issuer'));
  assert.ok(empty.includes('identifiers.1.value'));

  assert.ok(paths('contributor', { ...contributor(), identifiers: 'isni:1' }).includes('identifiers'));
  assert.ok(
    paths('contributor', {
      ...contributor(),
      identifiers: Array.from(
        { length: ENTITY_EDIT_LIMITS.maxIdentifiers + 1 },
        (_, index) => ({ issuer: 'isni', value: String(index) })
      )
    }).includes('identifiers')
  );
});

test('bounds identifier issuer and value', () => {
  assert.ok(
    paths('contributor', {
      ...contributor(),
      identifiers: [
        { issuer: 'x'.repeat(ENTITY_EDIT_LIMITS.identifierIssuer + 1), value: '1' }
      ]
    }).includes('identifiers.0.issuer')
  );
  assert.ok(
    paths('contributor', {
      ...contributor(),
      identifiers: [
        { issuer: 'isni', value: 'x'.repeat(ENTITY_EDIT_LIMITS.identifierValue + 1) }
      ]
    }).includes('identifiers.0.value')
  );
});

test('requires an absolute http(s) image URL', () => {
  for (const imageUrl of ['https://example.org/a.jpg', 'http://example.org/a.jpg']) {
    assert.deepEqual(paths('contributor', { ...contributor(), imageUrl }), [], imageUrl);
  }
  for (const imageUrl of ['javascript:alert(1)', '/relative.jpg', 'ftp://example.org/a.jpg', 'example.org']) {
    assert.ok(paths('contributor', { ...contributor(), imageUrl }).includes('imageUrl'), imageUrl);
  }
  assert.ok(
    paths('publisher', {
      ...publisher(),
      imageUrl: `https://example.org/${'x'.repeat(ENTITY_EDIT_LIMITS.imageUrl)}`
    }).includes('imageUrl')
  );
});

test('accepts real leap dates and rejects impossible ones', () => {
  assert.equal(strictCalendarDate('2024-02-29'), '2024-02-29');
  assert.equal(strictCalendarDate(' 1984-06-01 '), '1984-06-01');
  for (const value of [
    '2023-02-29',
    '2024-02-30',
    '2024-13-01',
    '2024-00-10',
    '2024-6-1',
    '2024',
    '2024-02',
    '0000-00-00'
  ]) {
    assert.equal(strictCalendarDate(value), null, value);
  }
});

test('applies strict dates to born/died and started/ended', () => {
  const contributorDates = parseEntityEdit('contributor', {
    ...contributor(),
    born: '1920-10-08',
    died: '1986-02-11'
  });
  assert.deepEqual(contributorDates.errors, []);
  assert.equal(contributorDates.value?.born, '1920-10-08');
  assert.equal(contributorDates.value?.died, '1986-02-11');

  const publisherDates = parseEntityEdit('publisher', {
    ...publisher(),
    started: '2024-02-29',
    ended: ''
  });
  assert.deepEqual(publisherDates.errors, []);
  assert.equal(publisherDates.value?.started, '2024-02-29');
  assert.equal(publisherDates.value?.ended, null);

  for (const field of ['born', 'died'] as const) {
    assert.ok(paths('contributor', { ...contributor(), [field]: '2023-02-29' }).includes(field));
    assert.ok(paths('contributor', { ...contributor(), [field]: '1986-2-11' }).includes(field));
  }
  for (const field of ['started', 'ended'] as const) {
    assert.ok(paths('publisher', { ...publisher(), [field]: '2024-02-30' }).includes(field));
  }
});

test('echoes a bounded expectedRevision', () => {
  const parsed = parseEntityEdit('contributor', {
    ...contributor(),
    expectedRevision: 'a'.repeat(64)
  });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.value?.expectedRevision, 'a'.repeat(64));
  assert.ok(
    paths('contributor', {
      ...contributor(),
      expectedRevision: 'a'.repeat(ENTITY_EDIT_LIMITS.expectedRevision + 1)
    }).includes('expectedRevision')
  );
});

test('rejects a non-object body', () => {
  for (const body of [null, 'name', [], 3]) {
    const parsed = parseEntityEdit('contributor', body);
    assert.equal(parsed.value, null);
    assert.equal(parsed.errors[0]?.message, 'request body must be an object');
  }
});
