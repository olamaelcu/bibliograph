import test from 'node:test';
import assert from 'node:assert/strict';

import { createGoodreads } from '../lib/providers/goodreads.js';

const ISBN13 = '9780441013593';
const ISBN10 = '0441013597';
const BASE = 'https://www.goodreads.com';

const bookPageHtml = `<html><head></head><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      apolloState: {
        'Book:kca://book/dune': {
          __typename: 'Book',
          legacyId: 260994194,
          title: 'Dune',
          titleComplete: 'Dune',
          imageUrl: 'https://img.example/dune.jpg',
          description: 'A desert planet.',
          details: {
            isbn13: ISBN13,
            isbn: ISBN10,
            numPages: 528,
            format: 'Hardcover',
            publisher: 'Ace',
            publicationTime: 1623715200000,
            language: { name: 'English' }
          },
          primaryContributorEdge: { node: { __ref: 'Contributor:d' }, role: 'Author' },
          secondaryContributorEdges: [],
          bookSeries: []
        },
        'Contributor:d': { __typename: 'Contributor', name: 'Frank Herbert' }
      }
    }
  }
})}</script></body></html>`;

// A search results page that no longer carries a book page payload; the
// legacy table parser is the only way a candidate comes out of it.
const searchPageHtml = `<table><tr itemscope>
<td><a href="/book/show/260994194"><img class="bookCover" itemprop="image" src="https://img.example/dune.jpg" /></a></td>
<td><a class="bookTitle" itemprop="url" href="/book/show/260994194.Dune"><span itemprop='name' role='heading'>Dune</span></a>
<span itemprop='author' itemscope='' itemtype='http://schema.org/Person'><div class='authorName__container'><a class="authorName" itemprop="url" href="/author/show/58"><span itemprop="name">Frank Herbert</span></a></div></span></td>
</tr></table>`;

function response({ status = 200, body = '', url }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    text: async () => body
  };
}

/** A fetch double that records calls and answers from `routes`. */
function recorder(routes) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push({ url, path, headers: options.headers ?? {} });
    const route = routes[path] ?? routes['*'];
    if (!route) return response({ status: 404, url });
    return route(url);
  };
  return { requests, fetchImpl };
}

test('byIdentifier resolves an ISBN through the book page and parses its format', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: bookPageHtml })
  });
  const provider = createGoodreads({ baseUrl: BASE, fetchImpl });

  const candidates = await provider.byIdentifier(ISBN13);

  assert.equal(requests.length, 1, 'no search fallback when the ISBN page answers');
  assert.equal(requests[0].path, `/book/isbn/${ISBN13}`);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, 'Dune');
  assert.equal(candidates[0].format, 'Hardcover');
  assert.equal(candidates[0].publisher.name, 'Ace');
  assert.deepEqual(candidates[0].identifiers, [
    { issuer: 'goodreads', value: '260994194' },
    { issuer: 'isbn13', value: ISBN13 }
  ]);
});

test('byIdentifier normalises an ISBN-10 before the book page lookup', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: bookPageHtml })
  });
  const provider = createGoodreads({ baseUrl: BASE, fetchImpl });

  const candidates = await provider.byIdentifier(ISBN10);

  assert.deepEqual(
    requests.map((request) => request.path),
    [`/book/isbn/${ISBN13}`]
  );
  assert.equal(candidates[0].format, 'Hardcover');
});

test('byIdentifier falls back to search when the ISBN page has no candidate', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) =>
      response({ url, body: '<html><body>No such edition</body></html>' }),
    '/search': (url) => response({ url, body: searchPageHtml })
  });
  const provider = createGoodreads({ baseUrl: BASE, fetchImpl });

  const candidates = await provider.byIdentifier(ISBN13);

  assert.deepEqual(
    requests.map((request) => request.path),
    [`/book/isbn/${ISBN13}`, '/search']
  );
  assert.equal(new URL(requests[1].url).searchParams.get('q'), ISBN13);
  // `application/xhtml+xml` makes Goodreads redirect `/search` back to itself.
  assert.equal(requests[1].headers.accept, undefined);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].identifiers, [
    { issuer: 'goodreads', value: '260994194' }
  ]);
  assert.equal(candidates[0].title, 'Dune');
});

test('byIdentifier falls back to search when the ISBN page is missing', async () => {
  const bookUrl = `${BASE}/book/show/260994194.Dune`;
  const { requests, fetchImpl } = recorder({
    '/search': () => response({ url: bookUrl, body: bookPageHtml })
  });
  const provider = createGoodreads({ baseUrl: BASE, fetchImpl });

  const candidates = await provider.byIdentifier(ISBN13);

  assert.deepEqual(
    requests.map((request) => request.path),
    [`/book/isbn/${ISBN13}`, '/search']
  );
  // The search redirect lands on the book page, so the book parser is used.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].format, 'Hardcover');
});

test('byId keeps the numeric book path and search drops the looping Accept', async () => {
  const { requests, fetchImpl } = recorder({
    '/book/show/260994194': (url) => response({ url, body: bookPageHtml }),
    '/search': (url) => response({ url, body: searchPageHtml })
  });
  const provider = createGoodreads({ baseUrl: BASE, fetchImpl });

  const byId = await provider.byId('260994194');
  assert.equal(requests[0].path, '/book/show/260994194');
  assert.equal(byId[0].format, 'Hardcover');

  const fromSearch = await provider.search('left hand');
  assert.equal(requests[1].path, '/search');
  assert.equal(new URL(requests[1].url).searchParams.get('q'), 'left hand');
  assert.equal(requests[1].headers.accept, undefined);
  assert.equal(requests[1].headers['user-agent'].includes('Bibliograph'), true);
  assert.deepEqual(
    fromSearch.map((candidate) => candidate.title),
    ['Dune']
  );
});

test('a consent wall still yields no candidates instead of throwing', async () => {
  const { requests, fetchImpl } = recorder({
    '*': (url) => response({ status: 403, url })
  });
  const provider = createGoodreads({ baseUrl: BASE, fetchImpl });

  assert.deepEqual(await provider.byIdentifier(ISBN13), []);
  // The ISBN page is refused, then the search fallback is refused too; both
  // are answers, not outages, so nothing is retried or thrown.
  assert.deepEqual(
    requests.map((request) => request.path),
    [`/book/isbn/${ISBN13}`, '/search']
  );
});
