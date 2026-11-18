import { expect, test } from 'vitest';

import {
  canonicalIdentifiers,
  canonicalIdentifiersJson,
  clippedText
} from '../lib/record-fields.js';

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemes(value) {
  return [...SEGMENTER.segment(value)].length;
}

test('clippedText drops a blank value', () => {
  expect(clippedText('   ', { maxGraphemes: 1024, maxBytes: 8192 })).toBe(undefined);
  expect(clippedText(undefined, { maxGraphemes: 1024, maxBytes: 8192 })).toBe(undefined);
});

test('clippedText clips to the grapheme bound', () => {
  const result = clippedText('a'.repeat(1500), { maxGraphemes: 1024, maxBytes: 8192 });
  expect(result.length).toBe(1024);
  expect(result).toBe('a'.repeat(1024));
});

test('clippedText keeps a multi-code-point grapheme whole', () => {
  const text = '👩‍🚀'.repeat(3);
  const byGraphemes = clippedText(text, { maxGraphemes: 1024, maxBytes: 8192 });
  expect(byGraphemes).toBe(text);
  expect(graphemes(byGraphemes)).toBe(3);

  // Each astronaut is one grapheme but eleven UTF-8 bytes, so the byte bound
  // stops on a grapheme boundary instead of splitting one.
  const byBytes = clippedText(text, { maxGraphemes: 1024, maxBytes: 30 });
  expect(byBytes).toBe('👩‍🚀'.repeat(2));
  expect(graphemes(byBytes)).toBe(2);
});

test('canonicalIdentifiers serializes a set the same way whatever the input order', () => {
  // Precomposed and decomposed `é` are distinct strings that collate equal, so
  // a collation-only comparator left their order to the input, and two rows
  // recording the same set produced different `(lower(name), identifiers)` keys.
  const composed = { issuer: 'é', value: 'a' };
  const decomposed = { issuer: 'e\u0301', value: 'a' };

  expect(canonicalIdentifiers([decomposed, composed])).toEqual(canonicalIdentifiers([composed, decomposed]));
});

test('canonicalIdentifiersJson stores one identity bag whatever the input order', () => {
  const hiveId = { issuer: 'bookhive.buzz', value: 'bk_scope' };
  const isbn = { issuer: 'isbn13', value: '9780441013593' };

  // The identity index compares `(lower(name), identifiers)` as jsonb, which is
  // positional: one set has to produce one stored string.
  expect(canonicalIdentifiersJson([isbn, hiveId])).toBe(canonicalIdentifiersJson([hiveId, isbn]));
  expect(JSON.parse(canonicalIdentifiersJson([isbn, hiveId, isbn]))).toEqual([hiveId, isbn]);
  expect(canonicalIdentifiersJson(undefined)).toBe('[]');
  expect(canonicalIdentifiersJson({ issuer: 'isbn13', value: '9780441013593' })).toBe('[]');
});
