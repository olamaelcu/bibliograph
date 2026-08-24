import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleBooksEnricher } from './google-books-enricher';

test('GoogleBooksEnricher has expected name', () => {
  const e = new GoogleBooksEnricher();
  assert.equal(e.name, 'google-books-enricher');
});