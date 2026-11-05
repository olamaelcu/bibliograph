import test from 'node:test';
import assert from 'node:assert/strict';
import {
  goodreadsBookUrl,
  grEditionRkey,
  grEditionUri,
  grIdFromIdentifier,
  grIdFromRkey,
  isGrRkey,
} from './keys';

test('gr keys are the numeric Goodreads book id', () => {
  assert.equal(grEditionRkey('23692271'), 'gr.23692271');
  assert.equal(grIdFromRkey('gr.23692271'), '23692271');
  assert.match(grEditionUri('23692271'), /\/community\.lexicon\.book\.edition\/gr\.23692271$/);
});

test('gr keys reject other provider families and non-ids', () => {
  assert.equal(isGrRkey('gr.23692271'), true);
  assert.equal(isGrRkey('ol.OL1M'), false);
  assert.equal(isGrRkey('gr.not-a-number'), false);
  assert.equal(isGrRkey('gr.'), false);
});

test('gr identifiers round-trip to the book id', () => {
  assert.equal(grIdFromIdentifier(goodreadsBookUrl('23692271')), '23692271');
  assert.equal(grIdFromIdentifier('https://www.goodreads.com/book/show/23692271?ref=x'), '23692271');
  assert.equal(grIdFromIdentifier('https://example.com/book/show/1'), null);
});
