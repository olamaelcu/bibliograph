import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEditionKey,
  parseWorkKey,
  parseAuthorKey,
  editionRkey,
  workRkey,
  contributorRkey,
  editionUri,
  workUri,
  contributorUri,
} from './keys.js';

test('parseEditionKey accepts /books/OL123M', () => {
  assert.equal(parseEditionKey('/books/OL2741128M'), 'OL2741128M');
});

test('parseEditionKey rejects /works/', () => {
  assert.throws(() => parseEditionKey('/works/OL66554W'), /edition key must start with \/books/);
});

test('parseEditionKey rejects malformed OLID', () => {
  assert.throws(() => parseEditionKey('/books/OL12345X'), /invalid edition OLID/);
});

test('parseWorkKey accepts /works/OL66554W', () => {
  assert.equal(parseWorkKey('/works/OL66554W'), 'OL66554W');
});

test('parseWorkKey rejects /books/', () => {
  assert.throws(() => parseWorkKey('/books/OL2741128M'), /work key must start with \/works/);
});

test('parseWorkKey rejects malformed OLID', () => {
  assert.throws(() => parseWorkKey('/works/OL66554X'), /invalid work OLID/);
});

test('parseAuthorKey accepts /authors/OL12345A', () => {
  assert.equal(parseAuthorKey('/authors/OL12345A'), 'OL12345A');
});

test('parseAuthorKey rejects /works/', () => {
  assert.throws(() => parseAuthorKey('/works/OL66554W'), /author key must start with \/authors/);
});

test('editionRkey produces ol.OL123M', () => {
  assert.equal(editionRkey('OL2741128M'), 'ol.OL2741128M');
});

test('editionRkey rejects non-M suffix', () => {
  assert.throws(() => editionRkey('OL12345W'), /invalid edition OLID/);
});

test('workRkey transforms OL66554W to ol.W66554W', () => {
  assert.equal(workRkey('OL66554W'), 'ol.W66554W');
});

test('workRkey rejects non-W suffix', () => {
  assert.throws(() => workRkey('OL12345M'), /invalid work OLID/);
});

test('contributorRkey transforms OL12345A to ol.A12345A', () => {
  assert.equal(contributorRkey('OL12345A'), 'ol.A12345A');
});

test('contributorRkey rejects non-A suffix', () => {
  assert.throws(() => contributorRkey('OL12345W'), /invalid author OLID/);
});

test('editionUri includes correct collection', () => {
  const uri = editionUri('OL2741128M');
  assert.ok(uri.startsWith('at://'));
  assert.ok(uri.includes('community.lexicon.book.edition/ol.OL2741128M'));
});

test('workUri transforms correctly', () => {
  const uri = workUri('OL66554W');
  assert.ok(uri.includes('community.lexicon.book.work/ol.W66554W'));
});

test('contributorUri is formatted correctly', () => {
  const uri = contributorUri('OL12345A');
  assert.ok(uri.includes('community.lexicon.book.contributor/ol.A12345A'));
});