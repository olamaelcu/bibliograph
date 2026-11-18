import { expect, test } from 'vitest';

import { parseBookEdit } from '../src/lib/admin/book-edit.ts';

const valid = () => ({
  title: 'Dune',
  identifiers: [{ issuer: 'isbn13', value: '9780441013593' }],
  contributors: [{ name: 'Frank Herbert', role: 'author' }]
});

/** `valid()` with a shape claim on its single identifier. */
const withInfo = (info: unknown) => ({
  ...valid(),
  identifiers: [{ issuer: 'isbn13', value: '9780441013593', info }]
});

/** `valid()` with extra fields on its single identifier. */
const withIdentifier = (extra: Record<string, unknown>) => ({
  ...valid(),
  identifiers: [{ issuer: 'isbn13', value: '9780441013593', ...extra }]
});

function paths(body: unknown): string[] {
  return parseBookEdit(body).errors.map((issue) => issue.path);
}

test('accepts a minimal edition and normalises defaults', () => {
  const parsed = parseBookEdit(valid());
  expect(parsed.errors).toEqual([]);
  expect(parsed.value).toBeTruthy();
  expect(parsed.value.title).toBe('Dune');
  expect(parsed.value.contributors[0]?.role).toBe('A01');
  expect(parsed.value.contributors[0]?.id).toBe(null);
  expect(parsed.value.subtitle).toBe(null);
  expect(parsed.value.expectedRevision).toBe(null);
  // No `info` key at all: an omitted claim leaves the stored row untouched.
  expect('info' in (parsed.value.identifiers[0] as object)).toBe(false);
});

test('requires a non-empty title and at least one identifier and contributor', () => {
  expect(paths({ title: '  ', identifiers: [], contributors: [] }).includes('title')).toBeTruthy();
  expect(paths({ ...valid(), identifiers: [] }).includes('identifiers')).toBeTruthy();
  expect(paths({ ...valid(), contributors: [] }).includes('contributors')).toBeTruthy();
  expect(paths({ ...valid(), contributors: undefined }).includes('contributors')).toBeTruthy();
});

test('bounds string lengths', () => {
  expect(paths({ ...valid(), title: 'x'.repeat(501) }).includes('title')).toBeTruthy();
  expect(paths(withInfo({ description: 'x'.repeat(20_001) })).includes(
      'identifiers.0.info.description'
    )).toBeTruthy();
  expect(paths(withInfo({ format: 'x'.repeat(101) })).includes('identifiers.0.info.format')).toBeTruthy();
  expect(paths(withInfo({ language: 'x'.repeat(36) })).includes('identifiers.0.info.language')).toBeTruthy();
});

test('canonicalises valid BCP 47 language tags', () => {
  for (const [input, expected] of [
    ['en', 'en'],
    ['en-US', 'en-US'],
    ['EN-us', 'en-US'],
    ['zh-Hant-TW', 'zh-Hant-TW'],
    ['zh-hant-tw', 'zh-Hant-TW'],
    ['en-US-u-ca-gregory', 'en-US-u-ca-gregory'],
    ['ja-Latn-hepburn-heploc', 'ja-Latn-alalc97'],
    ['English', 'english']
  ]) {
    const parsed = parseBookEdit(withInfo({ language: input }));
    expect(parsed.errors, input).toEqual([]);
    expect(parsed.value?.identifiers[0]?.info?.language, input).toBe(expected);
  }
});

test('treats empty or missing language as null', () => {
  for (const value of [undefined, null, '', '   ']) {
    const parsed = parseBookEdit(withInfo({ language: value }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.value?.identifiers[0]?.info?.language).toBe(null);
  }
});

test('rejects invalid BCP 47 language tags', () => {
  for (const value of ['en_US', 'en-', 'en--US', '123', 'not a tag']) {
    const errors = parseBookEdit(withInfo({ language: value })).errors;
    expect(errors.some((issue) => issue.path === 'identifiers.0.info.language'), `expected a language error for ${JSON.stringify(value)}`).toBeTruthy();
  }
});

test('rejects negative, fractional and oversized integers', () => {
  expect(paths(withInfo({ pages: -1 })).includes('identifiers.0.info.pages')).toBeTruthy();
  expect(paths(withInfo({ durationSeconds: 1.5 })).includes('identifiers.0.info.durationSeconds')).toBeTruthy();
  expect(paths(withInfo({ durationSeconds: 3600 }))).toEqual([]);
  expect(paths({ ...valid(), chapters: 2_147_483_648 }).includes('chapters')).toBeTruthy();
  expect(paths({ ...valid(), chapters: null })).toEqual([]);
});

test('validates published dates, including calendar days', () => {
  const path = 'identifiers.0.info.publishedDate';
  expect(paths(withInfo({ publishedDate: '2024' }))).toEqual([]);
  expect(paths(withInfo({ publishedDate: '2024-02' }))).toEqual([]);
  expect(paths(withInfo({ publishedDate: '2024-02-29' }))).toEqual([]);
  expect(paths(withInfo({ publishedDate: '2024-02-30' })).includes(path)).toBeTruthy();
  expect(paths(withInfo({ publishedDate: '24' })).includes(path)).toBeTruthy();
  expect(paths(withInfo({ publishedDate: '2024-13' })).includes(path)).toBeTruthy();
});

test('identifier claims are optional, nullable and typed', () => {
  const parsed = parseBookEdit(
    withInfo({ pages: '12', format: 'hardcover', durationSeconds: 12 })
  );
  expect(parsed.errors).toEqual([]);
  expect(parsed.value?.identifiers[0]?.info).toEqual({
    format: 'hardcover',
    language: null,
    publishedDate: null,
    pages: 12,
    description: null,
    durationSeconds: 12
  });

  const durationOnly = parseBookEdit(withInfo({ durationSeconds: 1 }));
  expect(durationOnly.errors, 'a duration alone is a claim').toEqual([]);
  expect(durationOnly.value?.identifiers[0]?.info).toEqual({
    format: null,
    language: null,
    publishedDate: null,
    pages: null,
    description: null,
    durationSeconds: 1
  });

  const cleared = parseBookEdit(withInfo(null));
  expect(cleared.errors).toEqual([]);
  expect(cleared.value?.identifiers[0]?.info).toBe(null);

  expect(paths(withInfo('hardcover')).includes('identifiers.0.info')).toBeTruthy();
  expect(paths(withInfo([1])).includes('identifiers.0.info')).toBeTruthy();
});

test('requires an http(s) cover URL', () => {
  expect(paths({ ...valid(), coverUrl: 'https://example.org/c.jpg' })).toEqual([]);
  expect(paths({ ...valid(), coverUrl: 'http://example.org/c.jpg' })).toEqual([]);
  expect(paths({ ...valid(), coverUrl: 'javascript:alert(1)' }).includes('coverUrl')).toBeTruthy();
  expect(paths({ ...valid(), coverUrl: '/relative.jpg' }).includes('coverUrl')).toBeTruthy();
});

test('rejects duplicate or empty identifiers', () => {
  const duplicate = paths({
    ...valid(),
    identifiers: [
      { issuer: 'isbn13', value: '978' },
      { issuer: 'isbn13', value: '978' }
    ]
  });
  expect(duplicate.includes('identifiers.1')).toBeTruthy();
  const empty = paths({ ...valid(), identifiers: [{ issuer: 'isbn13', value: ' ' }] });
  expect(empty.includes('identifiers.0.value')).toBeTruthy();
});

test('normalises legacy roles and rejects unknown role tokens', () => {
  const editor = parseBookEdit({
    ...valid(),
    contributors: [{ name: 'A', role: 'editor' }]
  });
  expect(editor.value?.contributors[0]?.role).toBe('B01');
  const bad = paths({
    ...valid(),
    contributors: [{ name: 'A', role: 'chief-vibes' }]
  });
  expect(bad.includes('contributors.0.role')).toBeTruthy();
  for (const role of ['A55', 'A98', 'AAA', 'author2']) {
    expect(paths({ ...valid(), contributors: [{ name: 'A', role }] }).includes('contributors.0.role'), `expected ${role} to be rejected`).toBeTruthy();
  }
  for (const [role, expected] of [
    ['author', 'A01'],
    ['translator', 'B06'],
    ['narrator', 'E03'],
    ['A01', 'A01'],
    ['Z99', 'Z99']
  ]) {
    const parsed = parseBookEdit({ ...valid(), contributors: [{ name: 'A', role }] });
    expect(parsed.errors, role).toEqual([]);
    expect(parsed.value?.contributors[0]?.role, role).toBe(expected);
  }
  const blank = parseBookEdit({
    ...valid(),
    contributors: [{ name: 'A', role: '' }]
  });
  expect(blank.value?.contributors[0]?.role).toBe('A01');
});

test('validates a contributor per-edge ref as an at-uri', () => {
  expect(paths({
      ...valid(),
      contributors: [
        { id: 4, role: 'A01', ref: 'at://did:plc:test/net.olamaelcu.livtet.biblio.contributor/abc' }
      ]
    })).toEqual([]);
  expect(paths({ ...valid(), contributors: [{ id: 4, role: 'A01', ref: 'https://example.org' }] }).includes(
      'contributors.0.ref'
    )).toBeTruthy();
});

test('existing contributor ids must be positive integers', () => {
  expect(paths({ ...valid(), contributors: [{ id: 0, role: 'A01' }] }).includes('contributors.0.id')).toBeTruthy();
  expect(paths({ ...valid(), contributors: [{ id: 1.5, role: 'A01' }] }).includes('contributors.0.id')).toBeTruthy();
  expect(paths({ ...valid(), contributors: [{ id: 7, role: 'A01' }] })).toEqual([]);
});

test('series is optional but needs a name when a position or display is present', () => {
  expect(paths({ ...valid(), series: null })).toEqual([]);
  expect(paths({ ...valid(), series: { name: 'Saga', position: '2' } })).toEqual([]);
  expect(paths({ ...valid(), series: { name: '', position: '2' } }).includes('series.name')).toBeTruthy();
  expect(paths({ ...valid(), series: { name: '' } })).toEqual([]);
  expect(paths({ ...valid(), series: 'Saga' }).includes('series')).toBeTruthy();
});

test('publisher links hang off the identifier and accept ids or new names', () => {
  expect(paths(withIdentifier({ publishers: [{ id: 3 }] }))).toEqual([]);
  expect(paths(withIdentifier({ publishers: [{ name: 'Ace' }] }))).toEqual([]);
  expect(paths(withIdentifier({ publishers: [{ role: 'x' }] })).includes(
      'identifiers.0.publishers.0.name'
    )).toBeTruthy();
  expect(paths(withIdentifier({ publishers: 'Ace' })).includes('identifiers.0.publishers')).toBeTruthy();
  // Omitted links are not resent, so a partial client cannot clear them.
  const parsed = parseBookEdit(valid());
  expect('publishers' in (parsed.value?.identifiers[0] as object)).toBe(false);
});

test('non-object bodies are rejected', () => {
  expect(paths(null)).toEqual(['']);
  expect(paths([])).toEqual(['']);
  expect(paths('edition')).toEqual(['']);
});
