import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_PROFILES,
  GoodreadsChallengeError,
  GoodreadsRedirectLoopError,
  createGoodreads,
  createPageCache,
  genresFromBookPage,
  isChallengePage,
  profileHeaders
} from '../lib/providers/goodreads.js';

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

function response({ status = 200, body = '', url, headers }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get: (name) => headers?.[name.toLowerCase()] ?? null },
    text: async () => body
  };
}

/** Providers under test never sleep: the gate and backoff are injectable. */
function makeProvider(options = {}) {
  return createGoodreads({
    baseUrl: BASE,
    sleep: async () => {},
    random: () => 0.5,
    ...options
  });
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
  const provider = makeProvider({ fetchImpl });

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
  const provider = makeProvider({ fetchImpl });

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
  const provider = makeProvider({ fetchImpl });

  const candidates = await provider.byIdentifier(ISBN13);

  assert.deepEqual(
    requests.map((request) => request.path),
    [`/book/isbn/${ISBN13}`, '/search']
  );
  assert.equal(new URL(requests[1].url).searchParams.get('q'), ISBN13);
  // Any Accept naming html/xhtml makes `/search` redirect to itself; only the
  // bare wildcard is served (verified against the live WAF edge).
  assert.equal(requests[1].headers.accept, '*/*');
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
  const provider = makeProvider({ fetchImpl });

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
  const provider = makeProvider({ fetchImpl });

  const byId = await provider.byId('260994194');
  assert.equal(requests[0].path, '/book/show/260994194');
  assert.equal(byId[0].format, 'Hardcover');

  const fromSearch = await provider.search('left hand');
  assert.equal(requests[1].path, '/search');
  assert.equal(new URL(requests[1].url).searchParams.get('q'), 'left hand');
  assert.equal(requests[1].headers.accept, '*/*');
  assert.doesNotMatch(requests[1].headers.accept, /text\/html|application\/xhtml/);
  assert.equal(/Mozilla\/5\.0/.test(requests[1].headers['user-agent']), true);
  assert.equal(requests[1].headers['user-agent'].includes('Bibliograph'), false);
  assert.deepEqual(
    fromSearch.map((candidate) => candidate.title),
    ['Dune']
  );
});

test('a consent wall still yields no candidates instead of throwing', async () => {
  const { requests, fetchImpl } = recorder({
    '*': (url) => response({ status: 403, url })
  });
  const provider = makeProvider({ fetchImpl });

  assert.deepEqual(await provider.byIdentifier(ISBN13), []);
  // The ISBN page is refused, then the search fallback is refused too; both
  // are answers, not outages, so nothing is retried or thrown.
  assert.deepEqual(
    requests.map((request) => request.path),
    [`/book/isbn/${ISBN13}`, '/search']
  );
});

// --- resilience: profiles, challenges, throttling and cache -----------------

const WAF_CHALLENGE = `<!DOCTYPE html><html><head><title>Goodreads</title>
<script src="/aws-waf-token/challenge.js"></script></head><body>
<script>window.gokuProps = {"awsWafCookieDomainList":[]};</script>
</body></html>`;
const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title>
</head><body><script>window._cf_chl_opt = {};</script>
<p>Enable JavaScript and cookies to continue</p></body></html>`;

/** A fetch double that hands out a scripted sequence and records every call. */
function scriptedFetch(script) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, path: new URL(url).pathname, headers: options.headers ?? {} });
    const next = script.shift();
    if (!next) throw new Error(`unexpected fetch for ${url}`);
    return typeof next === 'function' ? next(url) : next;
  };
  return { requests, fetchImpl };
}

test('browser profiles are coherent, varied and free of cookies/auth', () => {
  assert.ok(BROWSER_PROFILES.length >= 3 && BROWSER_PROFILES.length <= 5);
  const ids = new Set();
  const languages = new Set();

  for (const profile of BROWSER_PROFILES) {
    ids.add(profile.id);
    languages.add(profile.acceptLanguage);
    assert.match(profile.userAgent, /^Mozilla\/5\.0 /, profile.id);
    assert.equal(profile.accept.book, 'text/html', profile.id);
    assert.doesNotMatch(profile.accept.book, /application\/xhtml/, profile.id);
    assert.equal(profile.accept.search, '*/*', profile.id);
    assert.doesNotMatch(profile.accept.search, /text\/html|application\/xhtml/, profile.id);

    const chrome = /Chrome\/(\d+)\./.exec(profile.userAgent);
    if (chrome) {
      assert.ok(profile.chUa, `${profile.id} is Chromium and needs sec-ch-ua`);
      assert.match(profile.chUa, new RegExp(`v="${chrome[1]}"`), profile.id);
      const expectedPlatform = /Android/.test(profile.userAgent) ? '"Android"' : '"Windows"';
      assert.equal(profile.chUaPlatform, expectedPlatform, profile.id);
      assert.equal(
        profile.chUaMobile,
        /Mobile/.test(profile.userAgent) ? '?1' : '?0',
        profile.id
      );
    } else {
      assert.equal(profile.chUa, undefined, `${profile.id} must not send client hints`);
    }

    const headers = profileHeaders(profile, { kind: 'book' });
    assert.equal(headers['user-agent'], profile.userAgent);
    assert.equal(headers.accept, profile.accept.book);
    assert.equal(headers['accept-language'], profile.acceptLanguage);
    assert.equal(headers['sec-fetch-mode'], 'navigate');
    assert.equal(headers['sec-fetch-dest'], 'document');
    assert.equal(headers['sec-fetch-site'], 'none');
    assert.equal(headers['sec-fetch-user'], '?1');
    assert.equal(headers['upgrade-insecure-requests'], '1');
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.referer, undefined);
  }

  assert.equal(ids.size, BROWSER_PROFILES.length);
  assert.ok(languages.size > 1, 'Accept-Language should vary across profiles');
});

test('book pages use the full Accept, search uses the non-looping wildcard, and profiles rotate', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: bookPageHtml }),
    '/search': (url) => response({ url, body: searchPageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  await provider.byId('260994194');
  await provider.search('dune');

  assert.equal(requests[0].headers.accept, 'text/html');
  assert.equal(requests[0].headers.referer, undefined);
  assert.equal(requests[0].headers['sec-fetch-site'], 'none');
  assert.equal(requests[1].headers.accept, '*/*');
  assert.equal(requests[1].headers.referer, `${BASE}/`);
  assert.equal(requests[1].headers['sec-fetch-site'], 'same-origin');
  assert.notEqual(requests[0].headers['user-agent'], requests[1].headers['user-agent']);
  for (const request of requests) {
    assert.ok(
      BROWSER_PROFILES.some((profile) => profile.userAgent === request.headers['user-agent'])
    );
  }
});

test('challenge detection covers 202, AWS WAF and Cloudflare bodies', () => {
  assert.equal(isChallengePage({ status: 202, text: '' }), true);
  assert.equal(isChallengePage({ status: 200, text: WAF_CHALLENGE }), true);
  assert.equal(isChallengePage({ status: 403, text: CLOUDFLARE_CHALLENGE }), true);
  const wafHeader = (action) => ({
    get: (name) => (name === 'x-amzn-waf-action' ? action : null)
  });
  assert.equal(isChallengePage({ status: 200, text: '', headers: wafHeader('challenge') }), true);
  assert.equal(isChallengePage({ status: 403, text: '', headers: wafHeader('block') }), true);
  assert.equal(
    isChallengePage({ status: 200, text: bookPageHtml, headers: wafHeader('allow') }),
    false
  );
  assert.equal(isChallengePage({ status: 200, text: bookPageHtml }), false);
  assert.equal(isChallengePage({ status: 200, text: searchPageHtml }), false);
  assert.equal(isChallengePage(undefined), false);
});

test('a WAF challenge fails the logical request immediately and reports the block', async () => {
  const { requests, fetchImpl } = scriptedFetch([
    response({ status: 202, url: `${BASE}/book/isbn/${ISBN13}`, body: WAF_CHALLENGE })
  ]);
  const blocked = [];
  const provider = makeProvider({
    fetchImpl,
    gate: (task) => task(),
    onBlocked: (error) => blocked.push(error)
  });

  await assert.rejects(
    provider.byIdentifier(ISBN13),
    (error) =>
      error instanceof GoodreadsChallengeError &&
      error.code === 'GOODREADS_CHALLENGE' &&
      error.status === 502
  );
  assert.equal(requests.length, 1, 'a challenge is not retried inline');
  assert.equal(blocked.length, 1, 'the block opens the breaker hook');
});

test('403 challenge bodies and x-amzn-waf-action are blocks, not consent walls', async () => {
  const bodyBlock = scriptedFetch([
    response({ status: 403, url: `${BASE}/book/show/1`, body: CLOUDFLARE_CHALLENGE })
  ]);
  await assert.rejects(
    makeProvider({ fetchImpl: bodyBlock.fetchImpl, gate: (task) => task() }).byId('1'),
    GoodreadsChallengeError
  );
  assert.equal(bodyBlock.requests.length, 1);

  const headerBlock = scriptedFetch([
    response({
      status: 403,
      url: `${BASE}/book/show/1`,
      body: '',
      headers: { 'x-amzn-waf-action': 'block' }
    })
  ]);
  await assert.rejects(
    makeProvider({ fetchImpl: headerBlock.fetchImpl, gate: (task) => task() }).byId('1'),
    GoodreadsChallengeError
  );
  assert.equal(headerBlock.requests.length, 1);
});

test('a 200 page carrying x-amzn-waf-action is never parsed as an empty success', async () => {
  const { requests, fetchImpl } = scriptedFetch([
    response({
      status: 200,
      url: `${BASE}/book/isbn/${ISBN13}`,
      body: '',
      headers: { 'x-amzn-waf-action': 'challenge' }
    })
  ]);
  await assert.rejects(
    makeProvider({ fetchImpl, gate: (task) => task() }).byIdentifier(ISBN13),
    GoodreadsChallengeError
  );
  assert.equal(requests.length, 1);
});

test('a redirect loop is retried once, then surfaced as a provider error', async () => {
  const sleeps = [];
  const loop = () => {
    const error = new TypeError('fetch failed');
    error.cause = new Error('redirect count exceeded');
    throw error;
  };
  const { requests, fetchImpl } = scriptedFetch([loop, loop]);
  const blocked = [];
  const provider = makeProvider({
    fetchImpl,
    gate: (task) => task(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    onBlocked: (error) => blocked.push(error)
  });

  await assert.rejects(
    provider.search('dune'),
    (error) =>
      error instanceof GoodreadsRedirectLoopError &&
      error.code === 'GOODREADS_REDIRECT_LOOP' &&
      error.status === 502
  );
  assert.equal(requests.length, 2, 'loops are retried at most once');
  assert.deepEqual(sleeps, [500], 'the retry backoff is jittered from a 1 s base');
  assert.equal(blocked.length, 1);
});

test('a redirect loop that succeeds on the single retry is not an error', async () => {
  const loop = () => {
    const error = new TypeError('fetch failed');
    error.cause = new Error('redirect count exceeded');
    throw error;
  };
  const { requests, fetchImpl } = scriptedFetch([
    loop,
    response({ url: `${BASE}/book/isbn/${ISBN13}`, body: bookPageHtml })
  ]);
  const provider = makeProvider({ fetchImpl, gate: (task) => task() });

  const candidates = await provider.byIdentifier(ISBN13);

  assert.equal(candidates[0].format, 'Hardcover');
  assert.equal(requests.length, 2);
});

test('successful HTML is cached so repeated ISBN lookups skip the network', async () => {
  let clock = 0;
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: bookPageHtml })
  });
  const cache = createPageCache({ ttlMs: 1000, maxEntries: 10, now: () => clock });
  const provider = makeProvider({ fetchImpl, cache, now: () => clock });

  assert.equal((await provider.byIdentifier(ISBN13))[0].format, 'Hardcover');
  assert.equal((await provider.byIdentifier(ISBN13))[0].format, 'Hardcover');
  assert.equal(requests.length, 1, 'the second lookup is a cache hit');
  assert.equal(cache.size, 1);

  clock = 1000;
  assert.equal((await provider.byIdentifier(ISBN13))[0].format, 'Hardcover');
  assert.equal(requests.length, 2, 'an expired entry is refetched');
});

test('challenges and empty pages are never cached', async () => {
  const challengeCache = createPageCache({ ttlMs: 1000, maxEntries: 10, now: () => 0 });
  const first = scriptedFetch([
    response({ status: 202, url: `${BASE}/book/isbn/${ISBN13}`, body: WAF_CHALLENGE })
  ]);
  const challenged = makeProvider({
    fetchImpl: first.fetchImpl,
    gate: (task) => task(),
    cache: challengeCache
  });
  await assert.rejects(challenged.byIdentifier(ISBN13), GoodreadsChallengeError);
  assert.equal(challengeCache.size, 0);

  const emptyCache = createPageCache({ ttlMs: 1000, maxEntries: 10, now: () => 0 });
  const empty = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: '   ' })
  });
  const emptyProvider = makeProvider({ fetchImpl: empty.fetchImpl, cache: emptyCache });
  assert.deepEqual(await emptyProvider.byIdentifier(ISBN13), []);
  assert.equal(emptyCache.size, 0);
});

test('the page cache is bounded and evicts the least recently used page', () => {
  const cache = createPageCache({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
  cache.set('a', { text: 'a' });
  cache.set('b', { text: 'b' });
  cache.get('a');
  cache.set('c', { text: 'c' });

  assert.equal(cache.size, 2);
  assert.equal(cache.get('b'), undefined);
  assert.deepEqual(cache.get('a'), { text: 'a' });
  assert.deepEqual(cache.get('c'), { text: 'c' });
});

test('the serialized gate jitters its injected delay between requests', async () => {
  const delays = [];
  const { fetchImpl } = recorder({
    '*': (url) => response({ url, body: bookPageHtml })
  });
  const provider = makeProvider({
    fetchImpl,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 1
  });

  await provider.byId('1');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(delays, [2500]);
});

// ---------------------------------------------------------------------------
// Genres: inline `bookGenres` edges on a book page
// ---------------------------------------------------------------------------

const GOODREADS_ID = '234225';

const genrePageHtml = `<html><head></head><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      apolloState: {
        'Book:kca://book/dune': {
          __typename: 'Book',
          legacyId: 234225,
          title: 'Dune',
          details: { isbn13: ISBN13 },
          bookGenres: [
            { genre: { __ref: 'Genre:7' } },
            { genre: { name: 'Classics' } },
            { genre: { name: '   ' } },
            { genre: {} },
            { genre: { name: 'Audiobook' } }
          ]
        },
        'Genre:7': { __typename: 'Genre', name: 'Science Fiction' }
      }
    }
  }
})}</script></body></html>`;

test('genresFromBookPage reads inline and referenced genre entries', () => {
  assert.deepEqual(genresFromBookPage(genrePageHtml), [
    'Science Fiction',
    'Classics',
    'Audiobook'
  ]);
});

test('genresFromBookPage answers nothing for a page without the payload or genres', () => {
  assert.deepEqual(genresFromBookPage('<html><body>No such edition</body></html>'), []);
  // The plain book page carries no `bookGenres` at all.
  assert.deepEqual(genresFromBookPage(bookPageHtml), []);
});

test('genresForEdition reads the page of a Goodreads id', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/show/${GOODREADS_ID}`]: (url) => response({ url, body: genrePageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  const genres = await provider.genresForEdition([
    { issuer: 'isbn13', value: ISBN13 },
    { issuer: 'goodreads', value: GOODREADS_ID }
  ]);

  assert.deepEqual(genres, ['Science Fiction', 'Classics', 'Audiobook']);
  assert.deepEqual(
    requests.map((request) => request.path),
    [`/book/show/${GOODREADS_ID}`],
    'the Goodreads id wins over the ISBN'
  );
});

test('genresForEdition falls back to the ISBN route', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: genrePageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  const genres = await provider.genresForEdition([{ issuer: 'isbn13', value: ISBN13 }]);

  assert.equal(genres[0], 'Science Fiction');
  assert.deepEqual(requests.map((request) => request.path), [`/book/isbn/${ISBN13}`]);
});

test('genresForEdition never searches and answers nothing without a usable identifier', async () => {
  const { requests, fetchImpl } = recorder({
    '*': (url) => response({ url, body: genrePageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  assert.deepEqual(await provider.genresForEdition([{ issuer: 'goodreads', value: '' }]), []);
  assert.deepEqual(await provider.genresForEdition([]), []);
  assert.deepEqual(await provider.genresForEdition(), []);
  assert.equal(requests.length, 0, 'a fuzzy match on another book is worse than no genre');
});

test('genresForEdition answers nothing when the book page is missing', async () => {
  const { fetchImpl } = recorder({});
  const provider = makeProvider({ fetchImpl });

  assert.deepEqual(
    await provider.genresForEdition([{ issuer: 'goodreads', value: GOODREADS_ID }]),
    []
  );
});
