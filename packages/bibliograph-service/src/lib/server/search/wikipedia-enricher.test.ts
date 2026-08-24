import test from 'node:test';
import assert from 'node:assert/strict';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './wikipedia-enricher';

test('ContributorWikipediaEnricher has expected name', () => {
  const e = new ContributorWikipediaEnricher();
  assert.equal(e.name, 'wikipedia-enricher-contributor');
});

test('AuthorWikipediaEnricher has expected name', () => {
  const e = new AuthorWikipediaEnricher();
  assert.equal(e.name, 'wikipedia-enricher-author');
});