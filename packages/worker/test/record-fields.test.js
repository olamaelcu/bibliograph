import test from 'node:test';
import assert from 'node:assert/strict';

import { clippedText } from '../lib/record-fields.js';

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemes(value) {
  return [...SEGMENTER.segment(value)].length;
}

test('clippedText drops a blank value', () => {
  assert.equal(clippedText('   ', { maxGraphemes: 1024, maxBytes: 8192 }), undefined);
  assert.equal(clippedText(undefined, { maxGraphemes: 1024, maxBytes: 8192 }), undefined);
});

test('clippedText clips to the grapheme bound', () => {
  const result = clippedText('a'.repeat(1500), { maxGraphemes: 1024, maxBytes: 8192 });
  assert.equal(result.length, 1024);
  assert.equal(result, 'a'.repeat(1024));
});

test('clippedText keeps a multi-code-point grapheme whole', () => {
  const text = '👩‍🚀'.repeat(3);
  const byGraphemes = clippedText(text, { maxGraphemes: 1024, maxBytes: 8192 });
  assert.equal(byGraphemes, text);
  assert.equal(graphemes(byGraphemes), 3);

  // Each astronaut is one grapheme but eleven UTF-8 bytes, so the byte bound
  // stops on a grapheme boundary instead of splitting one.
  const byBytes = clippedText(text, { maxGraphemes: 1024, maxBytes: 30 });
  assert.equal(byBytes, '👩‍🚀'.repeat(2));
  assert.equal(graphemes(byBytes), 2);
});
