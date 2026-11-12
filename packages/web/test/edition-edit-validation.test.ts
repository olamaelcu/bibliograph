import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEditionEdit } from '../src/lib/admin/edition-edit.ts';

const valid = () => ({
  title: 'Dune',
  language: 'en',
  identifiers: [{ issuer: 'isbn13', value: '9780441013593' }],
  contributors: [{ name: 'Frank Herbert', role: 'author' }]
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
  assert.deepEqual(parsed.value.publishers, []);
  assert.equal(parsed.value.subtitle, null);
  assert.equal(parsed.value.expectedRevision, null);
});

test('requires a non-empty title and at least one identifier and contributor', () => {
  assert.ok(paths({ title: '  ', identifiers: [], contributors: [] }).includes('title'));
  assert.ok(paths({ ...valid(), identifiers: [] }).includes('identifiers'));
  assert.ok(paths({ ...valid(), contributors: [] }).includes('contributors'));
  assert.ok(paths({ ...valid(), contributors: undefined }).includes('contributors'));
});

test('bounds string lengths', () => {
  assert.ok(paths({ ...valid(), title: 'x'.repeat(501) }).includes('title'));
  assert.ok(paths({ ...valid(), description: 'x'.repeat(20_001) }).includes('description'));
  assert.ok(paths({ ...valid(), language: 'x'.repeat(36) }).includes('language'));
});

test('canonicalises valid BCP 47 language tags', () => {
  for (const [input, expected] of [
    ['en', 'en'],
    ['en-US', 'en-US'],
    ['EN-us', 'en-US'],
    ['zh-Hant-TW', 'zh-Hant-TW'],
    ['zh-hant-tw', 'zh-Hant-TW'],
    ['en-US-u-ca-gregory', 'en-US-u-ca-gregory']
  ]) {
    const parsed = parseEditionEdit({ ...valid(), language: input });
    assert.deepEqual(parsed.errors, [], input);
    assert.equal(parsed.value?.language, expected, input);
  }
});

test('rejects invalid or empty BCP 47 language tags', () => {
  for (const value of ['English', 'english', 'en_US', '', '   ', 'en-', '123']) {
    const errors = parseEditionEdit({ ...valid(), language: value }).errors;
    assert.ok(
      errors.some((issue) => issue.path === 'language'),
      `expected a language error for ${JSON.stringify(value)}`
    );
  }
  const missing = parseEditionEdit({ ...valid(), language: undefined }).errors;
  assert.ok(missing.some((issue) => issue.path === 'language'));
});

test('rejects negative, fractional and oversized integers', () => {
  assert.ok(paths({ ...valid(), pages: -1 }).includes('pages'));
  assert.ok(paths({ ...valid(), durationSeconds: 1.5 }).includes('durationSeconds'));
  assert.ok(paths({ ...valid(), chapters: 2_147_483_648 }).includes('chapters'));
  assert.deepEqual(paths({ ...valid(), pages: '0', chapters: null }), []);
});

test('validates published dates, including calendar days', () => {
  assert.deepEqual(paths({ ...valid(), publishedDate: '2024' }), []);
  assert.deepEqual(paths({ ...valid(), publishedDate: '2024-02' }), []);
  assert.deepEqual(paths({ ...valid(), publishedDate: '2024-02-29' }), []);
  assert.ok(paths({ ...valid(), publishedDate: '2024-02-30' }).includes('publishedDate'));
  assert.ok(paths({ ...valid(), publishedDate: '24' }).includes('publishedDate'));
  assert.ok(paths({ ...valid(), publishedDate: '2024-13' }).includes('publishedDate'));
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

test('publishers are optional and support existing ids or new names', () => {
  assert.deepEqual(paths({ ...valid(), publishers: [{ id: 3 }] }), []);
  assert.deepEqual(paths({ ...valid(), publishers: [{ name: 'Ace' }] }), []);
  assert.ok(paths({ ...valid(), publishers: [{ role: 'x' }] }).includes('publishers.0.name'));
  assert.ok(paths({ ...valid(), publishers: 'Ace' }).includes('publishers'));
});

test('non-object bodies are rejected', () => {
  assert.deepEqual(paths(null), ['']);
  assert.deepEqual(paths([]), ['']);
  assert.deepEqual(paths('edition'), ['']);
});
