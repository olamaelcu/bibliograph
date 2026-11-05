import test from 'node:test';
import assert from 'node:assert/strict';
import { formatViewFor, normalizeBookFormat } from './format-view';

test('normalizes provider bindings to the known values', () => {
  assert.equal(normalizeBookFormat('Hardcover'), 'hardcover');
  assert.equal(normalizeBookFormat('Paperback'), 'paperback');
  assert.equal(
    normalizeBookFormat('Mass Market Paperback'),
    'mass_market_paperback',
  );
  assert.equal(normalizeBookFormat('Ebook'), 'ebook');
  assert.equal(normalizeBookFormat('Kindle Edition'), 'ebook');
  assert.equal(normalizeBookFormat('Audiobook'), 'audiobook');
  assert.equal(normalizeBookFormat('Board Book'), 'board_book');
  assert.equal(normalizeBookFormat('Spiral-bound'), 'spiral_bound');
  assert.equal(normalizeBookFormat(null), undefined);
});

test('builds a format view whose format is a known value', () => {
  const view = formatViewFor('hardcover');
  assert.equal(view?.format, 'hardcover');
  assert.equal(view?.description, 'Hardcover');
  assert.match(view?.uri ?? '', /\/net\.olamaelcu\.livtet\.biblio\.format\/hardcover$/);

  const open = formatViewFor('zine');
  assert.equal(open?.format, 'zine');
  assert.equal(open?.description, 'Zine');
});
