import test from 'node:test';
import assert from 'node:assert/strict';
import { datacenterCoverUrl } from './cover-url';

test('rewrites the reader path to the publisher path', () => {
  assert.equal(
    datacenterCoverUrl('https://books.google.com/books/content?id=abc123&printsec=frontcover&img=1&zoom=1&source=gbs_api'),
    'https://books.google.com/books/publisher/content?id=abc123&printsec=frontcover&img=1&zoom=1&source=gbs_api',
  );
});

test('rewrites the CDN host and upgrades http', () => {
  assert.equal(
    datacenterCoverUrl('http://books.googleusercontent.com/books/content?id=abc123&printsec=frontcover&img=1&zoom=1'),
    'https://books.google.com/books/publisher/content?id=abc123&printsec=frontcover&img=1&zoom=1',
  );
});

test('leaves an already-publisher URL unchanged', () => {
  const url = 'https://books.google.com/books/publisher/content?id=abc123&printsec=frontcover&img=1&zoom=1';
  assert.equal(datacenterCoverUrl(url), url);
});

test('leaves non-Google and non-cover URLs unchanged', () => {
  assert.equal(
    datacenterCoverUrl('https://covers.isbndb.com/cover.jpg'),
    'https://covers.isbndb.com/cover.jpg',
  );
  assert.equal(
    datacenterCoverUrl('https://books.google.com/books?id=abc123'),
    'https://books.google.com/books?id=abc123',
  );
});

test('leaves unparseable input unchanged', () => {
  assert.equal(datacenterCoverUrl('not a url'), 'not a url');
  assert.equal(datacenterCoverUrl(''), '');
});
