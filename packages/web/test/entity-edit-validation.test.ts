import { expect, test } from 'vitest';

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
  expect(parsed.errors).toEqual([]);
  expect(parsed.value).toBeTruthy();
  expect(parsed.value.name).toBe('Frank Herbert');
  expect(parsed.value.nameInverted).toBe(null);
  expect(parsed.value.identifiers).toEqual([]);
  expect(parsed.value.description).toBe(null);
  expect(parsed.value.imageUrl).toBe(null);
  expect(parsed.value.born).toBe(null);
  expect(parsed.value.died).toBe(null);
  expect(parsed.value.expectedRevision).toBe(null);
});

test('accepts a minimal publisher and keeps only publisher date fields', () => {
  const parsed = parseEntityEdit('publisher', {
    ...publisher(),
    started: '1972-01-01',
    ended: '1998-12-31',
    born: 'not a date'
  });
  expect(parsed.errors).toEqual([]);
  expect(parsed.value).toBeTruthy();
  expect(parsed.value.name).toBe('Ace Books');
  expect(parsed.value.identifiers).toEqual([]);
  expect(parsed.value.started).toBe('1972-01-01');
  expect(parsed.value.ended).toBe('1998-12-31');
  expect('born' in parsed.value).toBe(false);
});

test('trims the name and inverted name', () => {
  const parsed = parseEntityEdit('contributor', {
    name: '  Frank Herbert  ',
    nameInverted: '  Herbert, Frank  '
  });
  expect(parsed.errors).toEqual([]);
  expect(parsed.value?.name).toBe('Frank Herbert');
  expect(parsed.value?.nameInverted).toBe('Herbert, Frank');
});

test('requires a bounded, non-blank name', () => {
  for (const body of [{}, { name: null }, { name: '   ' }, { name: 42 }]) {
    expect(paths('contributor', body).includes('name'), JSON.stringify(body)).toBeTruthy();
    expect(paths('publisher', body).includes('name'), JSON.stringify(body)).toBeTruthy();
  }
  expect(paths('contributor', { name: 'x'.repeat(ENTITY_EDIT_LIMITS.name + 1) }).includes('name')).toBeTruthy();
  expect(paths('contributor', { name: 'x'.repeat(ENTITY_EDIT_LIMITS.name) })).toEqual([]);
});

test('bounds the inverted name and description', () => {
  expect(paths('contributor', {
      ...contributor(),
      nameInverted: 'x'.repeat(ENTITY_EDIT_LIMITS.nameInverted + 1)
    }).includes('nameInverted')).toBeTruthy();
  expect(paths('publisher', {
      ...publisher(),
      description: 'x'.repeat(ENTITY_EDIT_LIMITS.description + 1)
    }).includes('description')).toBeTruthy();
  expect(paths('publisher', {
      ...publisher(),
      description: 'x'.repeat(ENTITY_EDIT_LIMITS.description)
    })).toEqual([]);
});

test('accepts unique identifier pairs and rejects empty or duplicate ones', () => {
  const parsed = parseEntityEdit('contributor', {
    ...contributor(),
    identifiers: [
      { issuer: 'isni', value: '0000000123456789' },
      { issuer: 'viaf', value: '123456' }
    ]
  });
  expect(parsed.errors).toEqual([]);
  expect(parsed.value?.identifiers).toEqual([
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
  expect(duplicate.includes('identifiers.1')).toBeTruthy();

  const empty = paths('contributor', {
    ...contributor(),
    identifiers: [
      { issuer: ' ', value: '1' },
      { issuer: 'isni', value: ' ' }
    ]
  });
  expect(empty.includes('identifiers.0.issuer')).toBeTruthy();
  expect(empty.includes('identifiers.1.value')).toBeTruthy();

  expect(paths('contributor', { ...contributor(), identifiers: 'isni:1' }).includes('identifiers')).toBeTruthy();
  expect(paths('contributor', {
      ...contributor(),
      identifiers: Array.from(
        { length: ENTITY_EDIT_LIMITS.maxIdentifiers + 1 },
        (_, index) => ({ issuer: 'isni', value: String(index) })
      )
    }).includes('identifiers')).toBeTruthy();
});

test('bounds identifier issuer and value', () => {
  expect(paths('contributor', {
      ...contributor(),
      identifiers: [
        { issuer: 'x'.repeat(ENTITY_EDIT_LIMITS.identifierIssuer + 1), value: '1' }
      ]
    }).includes('identifiers.0.issuer')).toBeTruthy();
  expect(paths('contributor', {
      ...contributor(),
      identifiers: [
        { issuer: 'isni', value: 'x'.repeat(ENTITY_EDIT_LIMITS.identifierValue + 1) }
      ]
    }).includes('identifiers.0.value')).toBeTruthy();
});

test('requires an absolute http(s) image URL', () => {
  for (const imageUrl of ['https://example.org/a.jpg', 'http://example.org/a.jpg']) {
    expect(paths('contributor', { ...contributor(), imageUrl }), imageUrl).toEqual([]);
  }
  for (const imageUrl of ['javascript:alert(1)', '/relative.jpg', 'ftp://example.org/a.jpg', 'example.org']) {
    expect(paths('contributor', { ...contributor(), imageUrl }).includes('imageUrl'), imageUrl).toBeTruthy();
  }
  expect(paths('publisher', {
      ...publisher(),
      imageUrl: `https://example.org/${'x'.repeat(ENTITY_EDIT_LIMITS.imageUrl)}`
    }).includes('imageUrl')).toBeTruthy();
});

test('accepts real leap dates and rejects impossible ones', () => {
  expect(strictCalendarDate('2024-02-29')).toBe('2024-02-29');
  expect(strictCalendarDate(' 1984-06-01 ')).toBe('1984-06-01');
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
    expect(strictCalendarDate(value), value).toBe(null);
  }
});

test('applies strict dates to born/died and started/ended', () => {
  const contributorDates = parseEntityEdit('contributor', {
    ...contributor(),
    born: '1920-10-08',
    died: '1986-02-11'
  });
  expect(contributorDates.errors).toEqual([]);
  expect(contributorDates.value?.born).toBe('1920-10-08');
  expect(contributorDates.value?.died).toBe('1986-02-11');

  const publisherDates = parseEntityEdit('publisher', {
    ...publisher(),
    started: '2024-02-29',
    ended: ''
  });
  expect(publisherDates.errors).toEqual([]);
  expect(publisherDates.value?.started).toBe('2024-02-29');
  expect(publisherDates.value?.ended).toBe(null);

  for (const field of ['born', 'died'] as const) {
    expect(paths('contributor', { ...contributor(), [field]: '2023-02-29' }).includes(field)).toBeTruthy();
    expect(paths('contributor', { ...contributor(), [field]: '1986-2-11' }).includes(field)).toBeTruthy();
  }
  for (const field of ['started', 'ended'] as const) {
    expect(paths('publisher', { ...publisher(), [field]: '2024-02-30' }).includes(field)).toBeTruthy();
  }
});

test('echoes a bounded expectedRevision', () => {
  const parsed = parseEntityEdit('contributor', {
    ...contributor(),
    expectedRevision: 'a'.repeat(64)
  });
  expect(parsed.errors).toEqual([]);
  expect(parsed.value?.expectedRevision).toBe('a'.repeat(64));
  expect(paths('contributor', {
      ...contributor(),
      expectedRevision: 'a'.repeat(ENTITY_EDIT_LIMITS.expectedRevision + 1)
    }).includes('expectedRevision')).toBeTruthy();
});

test('rejects a non-object body', () => {
  for (const body of [null, 'name', [], 3]) {
    const parsed = parseEntityEdit('contributor', body);
    expect(parsed.value).toBe(null);
    expect(parsed.errors[0]?.message).toBe('request body must be an object');
  }
});
