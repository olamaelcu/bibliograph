import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEditionEdit } from '../src/lib/admin/edition-edit.ts';

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
  return parseEditionEdit(body).errors.map((issue) => issue.path);
}

test('accepts a minimal edition and normalises defaults', () => {
  const parsed = parseEditionEdit(valid());
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.value);
  assert.equal(parsed.value.title, 'Dune');
  assert.equal(parsed.value.contributors[0]?.role, 'A01');
  assert.equal(parsed.value.contributors[0]?.id, null);
  assert.equal(parsed.value.subtitle, null);
  assert.equal(parsed.value.expectedRevision, null);
  // No `info` key at all: an omitted claim leaves the stored row untouched.
  assert.equal('info' in (parsed.value.identifiers[0] as object), false);
});

test('requires a non-empty title and at least one identifier and contributor', () => {
  assert.ok(paths({ title: '  ', identifiers: [], contributors: [] }).includes('title'));
  assert.ok(paths({ ...valid(), identifiers: [] }).includes('identifiers'));
  assert.ok(paths({ ...valid(), contributors: [] }).includes('contributors'));
  assert.ok(paths({ ...valid(), contributors: undefined }).includes('contributors'));
});

test('bounds string lengths', () => {
  assert.ok(paths({ ...valid(), title: 'x'.repeat(501) }).includes('title'));
  assert.ok(
    paths(withInfo({ description: 'x'.repeat(20_001) })).includes(
      'identifiers.0.info.description'
    )
  );
  assert.ok(paths(withInfo({ format: 'x'.repeat(101) })).includes('identifiers.0.info.format'));
  assert.ok(paths(withInfo({ language: 'x'.repeat(36) })).includes('identifiers.0.info.language'));
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
    const parsed = parseEditionEdit(withInfo({ language: input }));
    assert.deepEqual(parsed.errors, [], input);
    assert.equal(parsed.value?.identifiers[0]?.info?.language, expected, input);
  }
});

test('treats empty or missing language as null', () => {
  for (const value of [undefined, null, '', '   ']) {
    const parsed = parseEditionEdit(withInfo({ language: value }));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.value?.identifiers[0]?.info?.language, null);
  }
});

test('rejects invalid BCP 47 language tags', () => {
  for (const value of ['en_US', 'en-', 'en--US', '123', 'not a tag']) {
    const errors = parseEditionEdit(withInfo({ language: value })).errors;
    assert.ok(
      errors.some((issue) => issue.path === 'identifiers.0.info.language'),
      `expected a language error for ${JSON.stringify(value)}`
    );
  }
});

test('rejects negative, fractional and oversized integers', () => {
  assert.ok(paths(withInfo({ pages: -1 })).includes('identifiers.0.info.pages'));
  assert.ok(paths({ ...valid(), durationSeconds: 1.5 }).includes('durationSeconds'));
  assert.ok(paths({ ...valid(), chapters: 2_147_483_648 }).includes('chapters'));
  assert.deepEqual(paths({ ...valid(), chapters: null }), []);
});

test('validates published dates, including calendar days', () => {
  const path = 'identifiers.0.info.publishedDate';
  assert.deepEqual(paths(withInfo({ publishedDate: '2024' })), []);
  assert.deepEqual(paths(withInfo({ publishedDate: '2024-02' })), []);
  assert.deepEqual(paths(withInfo({ publishedDate: '2024-02-29' })), []);
  assert.ok(paths(withInfo({ publishedDate: '2024-02-30' })).includes(path));
  assert.ok(paths(withInfo({ publishedDate: '24' })).includes(path));
  assert.ok(paths(withInfo({ publishedDate: '2024-13' })).includes(path));
});

test('identifier claims are optional, nullable and typed', () => {
  const parsed = parseEditionEdit(withInfo({ pages: '12', format: 'hardcover' }));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.value?.identifiers[0]?.info, {
    format: 'hardcover',
    language: null,
    publishedDate: null,
    pages: 12,
    description: null
  });

  const cleared = parseEditionEdit(withInfo(null));
  assert.deepEqual(cleared.errors, []);
  assert.equal(cleared.value?.identifiers[0]?.info, null);

  assert.ok(paths(withInfo('hardcover')).includes('identifiers.0.info'));
  assert.ok(paths(withInfo([1])).includes('identifiers.0.info'));
});

test('requires an http(s) cover URL', () => {
  assert.deepEqual(paths({ ...valid(), coverUrl: 'https://example.org/c.jpg' }), []);
  assert.deepEqual(paths({ ...valid(), coverUrl: 'http://example.org/c.jpg' }), []);
  assert.ok(paths({ ...valid(), coverUrl: 'javascript:alert(1)' }).includes('coverUrl'));
  assert.ok(paths({ ...valid(), coverUrl: '/relative.jpg' }).includes('coverUrl'));
});

test('rejects duplicate or empty identifiers', () => {
  const duplicate = paths({
    ...valid(),
    identifiers: [
      { issuer: 'isbn13', value: '978' },
      { issuer: 'isbn13', value: '978' }
    ]
  });
  assert.ok(duplicate.includes('identifiers.1'));
  const empty = paths({ ...valid(), identifiers: [{ issuer: 'isbn13', value: ' ' }] });
  assert.ok(empty.includes('identifiers.0.value'));
});

test('normalises legacy roles and rejects unknown role tokens', () => {
  const editor = parseEditionEdit({
    ...valid(),
    contributors: [{ name: 'A', role: 'editor' }]
  });
  assert.equal(editor.value?.contributors[0]?.role, 'B01');
  const bad = paths({
    ...valid(),
    contributors: [{ name: 'A', role: 'chief-vibes' }]
  });
  assert.ok(bad.includes('contributors.0.role'));
  for (const role of ['A55', 'A98', 'AAA', 'author2']) {
    assert.ok(
      paths({ ...valid(), contributors: [{ name: 'A', role }] }).includes('contributors.0.role'),
      `expected ${role} to be rejected`
    );
  }
  for (const [role, expected] of [
    ['author', 'A01'],
    ['translator', 'B06'],
    ['narrator', 'E03'],
    ['A01', 'A01'],
    ['Z99', 'Z99']
  ]) {
    const parsed = parseEditionEdit({ ...valid(), contributors: [{ name: 'A', role }] });
    assert.deepEqual(parsed.errors, [], role);
    assert.equal(parsed.value?.contributors[0]?.role, expected, role);
  }
  const blank = parseEditionEdit({
    ...valid(),
    contributors: [{ name: 'A', role: '' }]
  });
  assert.equal(blank.value?.contributors[0]?.role, 'A01');
});

test('validates a contributor per-edge ref as an at-uri', () => {
  assert.deepEqual(
    paths({
      ...valid(),
      contributors: [
        { id: 4, role: 'A01', ref: 'at://did:plc:test/net.olamaelcu.livtet.biblio.contributor/abc' }
      ]
    }),
    []
  );
  assert.ok(
    paths({ ...valid(), contributors: [{ id: 4, role: 'A01', ref: 'https://example.org' }] }).includes(
      'contributors.0.ref'
    )
  );
});

test('existing contributor ids must be positive integers', () => {
  assert.ok(paths({ ...valid(), contributors: [{ id: 0, role: 'A01' }] }).includes('contributors.0.id'));
  assert.ok(
    paths({ ...valid(), contributors: [{ id: 1.5, role: 'A01' }] }).includes('contributors.0.id')
  );
  assert.deepEqual(paths({ ...valid(), contributors: [{ id: 7, role: 'A01' }] }), []);
});

test('series is optional but needs a name when a position or display is present', () => {
  assert.deepEqual(paths({ ...valid(), series: null }), []);
  assert.deepEqual(paths({ ...valid(), series: { name: 'Saga', position: '2' } }), []);
  assert.ok(paths({ ...valid(), series: { name: '', position: '2' } }).includes('series.name'));
  assert.deepEqual(paths({ ...valid(), series: { name: '' } }), []);
  assert.ok(paths({ ...valid(), series: 'Saga' }).includes('series'));
});

test('publisher links hang off the identifier and accept ids or new names', () => {
  assert.deepEqual(paths(withIdentifier({ publishers: [{ id: 3 }] })), []);
  assert.deepEqual(paths(withIdentifier({ publishers: [{ name: 'Ace' }] })), []);
  assert.ok(
    paths(withIdentifier({ publishers: [{ role: 'x' }] })).includes(
      'identifiers.0.publishers.0.name'
    )
  );
  assert.ok(paths(withIdentifier({ publishers: 'Ace' })).includes('identifiers.0.publishers'));
  // Omitted links are not resent, so a partial client cannot clear them.
  const parsed = parseEditionEdit(valid());
  assert.equal('publishers' in (parsed.value?.identifiers[0] as object), false);
});

test('non-object bodies are rejected', () => {
  assert.deepEqual(paths(null), ['']);
  assert.deepEqual(paths([]), ['']);
  assert.deepEqual(paths('edition'), ['']);
});
