import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthorWikipediaEnricher } from './wikipedia-enricher';

test('AuthorWikipediaEnricher has expected name', () => {
  const e = new AuthorWikipediaEnricher();
  assert.equal(e.name, 'wikipedia-enricher-author');
});