import { expect, test } from 'vitest';

import {
  BROWSER_PROFILES,
  GoodreadsChallengeError,
  GoodreadsRedirectLoopError,
  createGoodreads,
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

/**
 * The shared page cache's contract, in memory: async `get` and `put`, and the
 * TTL travels with the write because the table stores `expires_at`.
 */
function fakeCache() {
  const entries = new Map();
  return {
    entries,
    async get(key) {
      return entries.get(key)?.value;
    },
    async put(key, request, value, ttlMs) {
      entries.set(key, { request, value, ttlMs });
    }
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
  const provider = makeProvider({ fetchImpl });

  const candidates = await provider.byIdentifier(ISBN13);

  expect(requests.length, 'no search fallback when the ISBN page answers').toBe(1);
  expect(requests[0].path).toBe(`/book/isbn/${ISBN13}`);
  expect(candidates.length).toBe(1);
  expect(candidates[0].title).toBe('Dune');
  expect(candidates[0].format).toBe('Hardcover');
  expect(candidates[0].publisher.name).toBe('Ace');
  expect(candidates[0].identifiers).toEqual([
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

  expect(requests.map((request) => request.path)).toEqual([`/book/isbn/${ISBN13}`]);
  expect(candidates[0].format).toBe('Hardcover');
});

test('byIdentifier falls back to search when the ISBN page has no candidate', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) =>
      response({ url, body: '<html><body>No such edition</body></html>' }),
    '/search': (url) => response({ url, body: searchPageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  const candidates = await provider.byIdentifier(ISBN13);

  expect(requests.map((request) => request.path)).toEqual([`/book/isbn/${ISBN13}`, '/search']);
  expect(new URL(requests[1].url).searchParams.get('q')).toBe(ISBN13);
  // Any Accept naming html/xhtml makes `/search` redirect to itself; only the
  // bare wildcard is served (verified against the live WAF edge).
  expect(requests[1].headers.accept).toBe('*/*');
  expect(candidates.length).toBe(1);
  expect(candidates[0].identifiers).toEqual([
    { issuer: 'goodreads', value: '260994194' }
  ]);
  expect(candidates[0].title).toBe('Dune');
});

test('byIdentifier falls back to search when the ISBN page is missing', async () => {
  const bookUrl = `${BASE}/book/show/260994194.Dune`;
  const { requests, fetchImpl } = recorder({
    '/search': () => response({ url: bookUrl, body: bookPageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  const candidates = await provider.byIdentifier(ISBN13);

  expect(requests.map((request) => request.path)).toEqual([`/book/isbn/${ISBN13}`, '/search']);
  // The search redirect lands on the book page, so the book parser is used.
  expect(candidates.length).toBe(1);
  expect(candidates[0].format).toBe('Hardcover');
});

test('byId keeps the numeric book path and search drops the looping Accept', async () => {
  const { requests, fetchImpl } = recorder({
    '/book/show/260994194': (url) => response({ url, body: bookPageHtml }),
    '/search': (url) => response({ url, body: searchPageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  const byId = await provider.byId('260994194');
  expect(requests[0].path).toBe('/book/show/260994194');
  expect(byId[0].format).toBe('Hardcover');

  const fromSearch = await provider.search('left hand');
  expect(requests[1].path).toBe('/search');
  expect(new URL(requests[1].url).searchParams.get('q')).toBe('left hand');
  expect(requests[1].headers.accept).toBe('*/*');
  expect(requests[1].headers.accept).not.toMatch(/text\/html|application\/xhtml/);
  expect(/Mozilla\/5\.0/.test(requests[1].headers['user-agent'])).toBe(true);
  expect(requests[1].headers['user-agent'].includes('Bibliograph')).toBe(false);
  expect(fromSearch.map((candidate) => candidate.title)).toEqual(['Dune']);
});

test('a consent wall still yields no candidates instead of throwing', async () => {
  const { requests, fetchImpl } = recorder({
    '*': (url) => response({ status: 403, url })
  });
  const provider = makeProvider({ fetchImpl });

  expect(await provider.byIdentifier(ISBN13)).toEqual([]);
  // The ISBN page is refused, then the search fallback is refused too; both
  // are answers, not outages, so nothing is retried or thrown.
  expect(requests.map((request) => request.path)).toEqual([`/book/isbn/${ISBN13}`, '/search']);
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
  expect(BROWSER_PROFILES.length >= 3 && BROWSER_PROFILES.length <= 5).toBeTruthy();
  const ids = new Set();
  const languages = new Set();

  for (const profile of BROWSER_PROFILES) {
    ids.add(profile.id);
    languages.add(profile.acceptLanguage);
    expect(profile.userAgent, profile.id).toMatch(/^Mozilla\/5\.0 /);
    expect(profile.accept.book, profile.id).toBe('text/html');
    expect(profile.accept.book, profile.id).not.toMatch(/application\/xhtml/);
    expect(profile.accept.search, profile.id).toBe('*/*');
    expect(profile.accept.search, profile.id).not.toMatch(/text\/html|application\/xhtml/);

    const chrome = /Chrome\/(\d+)\./.exec(profile.userAgent);
    if (chrome) {
      expect(profile.chUa, `${profile.id} is Chromium and needs sec-ch-ua`).toBeTruthy();
      expect(profile.chUa, profile.id).toMatch(new RegExp(`v="${chrome[1]}"`));
      const expectedPlatform = /Android/.test(profile.userAgent) ? '"Android"' : '"Windows"';
      expect(profile.chUaPlatform, profile.id).toBe(expectedPlatform);
      expect(profile.chUaMobile, profile.id).toBe(/Mobile/.test(profile.userAgent) ? '?1' : '?0');
    } else {
      expect(profile.chUa, `${profile.id} must not send client hints`).toBe(undefined);
    }

    const headers = profileHeaders(profile, { kind: 'book' });
    expect(headers['user-agent']).toBe(profile.userAgent);
    expect(headers.accept).toBe(profile.accept.book);
    expect(headers['accept-language']).toBe(profile.acceptLanguage);
    expect(headers['sec-fetch-mode']).toBe('navigate');
    expect(headers['sec-fetch-dest']).toBe('document');
    expect(headers['sec-fetch-site']).toBe('none');
    expect(headers['sec-fetch-user']).toBe('?1');
    expect(headers['upgrade-insecure-requests']).toBe('1');
    expect(headers.cookie).toBe(undefined);
    expect(headers.authorization).toBe(undefined);
    expect(headers.referer).toBe(undefined);
  }

  expect(ids.size).toBe(BROWSER_PROFILES.length);
  expect(languages.size > 1, 'Accept-Language should vary across profiles').toBeTruthy();
});

test('book pages use the full Accept, search uses the non-looping wildcard, and profiles rotate', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: bookPageHtml }),
    '/search': (url) => response({ url, body: searchPageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  await provider.byId('260994194');
  await provider.search('dune');

  expect(requests[0].headers.accept).toBe('text/html');
  expect(requests[0].headers.referer).toBe(undefined);
  expect(requests[0].headers['sec-fetch-site']).toBe('none');
  expect(requests[1].headers.accept).toBe('*/*');
  expect(requests[1].headers.referer).toBe(`${BASE}/`);
  expect(requests[1].headers['sec-fetch-site']).toBe('same-origin');
  expect(requests[0].headers['user-agent']).not.toBe(requests[1].headers['user-agent']);
  for (const request of requests) {
    expect(BROWSER_PROFILES.some((profile) => profile.userAgent === request.headers['user-agent'])).toBeTruthy();
  }
});

test('challenge detection covers 202, AWS WAF and Cloudflare bodies', () => {
  expect(isChallengePage({ status: 202, text: '' })).toBe(true);
  expect(isChallengePage({ status: 200, text: WAF_CHALLENGE })).toBe(true);
  expect(isChallengePage({ status: 403, text: CLOUDFLARE_CHALLENGE })).toBe(true);
  const wafHeader = (action) => ({
    get: (name) => (name === 'x-amzn-waf-action' ? action : null)
  });
  expect(isChallengePage({ status: 200, text: '', headers: wafHeader('challenge') })).toBe(true);
  expect(isChallengePage({ status: 403, text: '', headers: wafHeader('block') })).toBe(true);
  expect(isChallengePage({ status: 200, text: bookPageHtml, headers: wafHeader('allow') })).toBe(false);
  expect(isChallengePage({ status: 200, text: bookPageHtml })).toBe(false);
  expect(isChallengePage({ status: 200, text: searchPageHtml })).toBe(false);
  expect(isChallengePage(undefined)).toBe(false);
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

  await expect(provider.byIdentifier(ISBN13)).rejects.toSatisfy((error) =>
      error instanceof GoodreadsChallengeError &&
      error.code === 'GOODREADS_CHALLENGE' &&
      error.status === 502);
  expect(requests.length, 'a challenge is not retried inline').toBe(1);
  expect(blocked.length, 'the block opens the breaker hook').toBe(1);
});

test('403 challenge bodies and x-amzn-waf-action are blocks, not consent walls', async () => {
  const bodyBlock = scriptedFetch([
    response({ status: 403, url: `${BASE}/book/show/1`, body: CLOUDFLARE_CHALLENGE })
  ]);
  await expect(makeProvider({ fetchImpl: bodyBlock.fetchImpl, gate: (task) => task() }).byId('1')).rejects.toThrow(GoodreadsChallengeError);
  expect(bodyBlock.requests.length).toBe(1);

  const headerBlock = scriptedFetch([
    response({
      status: 403,
      url: `${BASE}/book/show/1`,
      body: '',
      headers: { 'x-amzn-waf-action': 'block' }
    })
  ]);
  await expect(makeProvider({ fetchImpl: headerBlock.fetchImpl, gate: (task) => task() }).byId('1')).rejects.toThrow(GoodreadsChallengeError);
  expect(headerBlock.requests.length).toBe(1);
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
  await expect(makeProvider({ fetchImpl, gate: (task) => task() }).byIdentifier(ISBN13)).rejects.toThrow(GoodreadsChallengeError);
  expect(requests.length).toBe(1);
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

  await expect(provider.search('dune')).rejects.toSatisfy((error) =>
      error instanceof GoodreadsRedirectLoopError &&
      error.code === 'GOODREADS_REDIRECT_LOOP' &&
      error.status === 502);
  expect(requests.length, 'loops are retried at most once').toBe(2);
  expect(sleeps, 'the retry backoff is jittered from a 1 s base').toEqual([500]);
  expect(blocked.length).toBe(1);
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

  expect(candidates[0].format).toBe('Hardcover');
  expect(requests.length).toBe(2);
});

test('a successful page caches its parsed candidates, never the HTML', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: bookPageHtml })
  });
  const cache = fakeCache();
  const provider = makeProvider({ fetchImpl, cache });

  expect((await provider.byIdentifier(ISBN13))[0].format).toBe('Hardcover');
  expect((await provider.byIdentifier(ISBN13))[0].format).toBe('Hardcover');
  expect(requests.length, 'the second lookup is a cache hit').toBe(1);
  expect(cache.entries.size).toBe(1);

  // The table decides freshness from `expires_at`; a miss (an expired row is a
  // miss) refetches and rewrites.
  const [key, entry] = [...cache.entries.entries()][0];
  expect(key.endsWith(`/book/isbn/${ISBN13}|book`), 'the key is URL + page kind').toBe(true);
  expect(entry.request, 'the url column keeps the request').toBe(`${BASE}/book/isbn/${ISBN13}`);
  expect(entry.ttlMs, "the TTL is Goodreads' own max-age").toBe(24 * 60 * 60 * 1000);
  const cached = entry.value;
  expect(cached, 'the whole page is not kept: it was ~170 KB a row').not.toHaveProperty('text');
  expect(cached.url).toBe(`${BASE}/book/isbn/${ISBN13}`);
  expect(cached.status).toBe(200);
  expect(cached.candidates.book[0].format).toBe('Hardcover');
  expect(Array.isArray(cached.genres)).toBe(true);

  cache.entries.clear();
  expect((await provider.byIdentifier(ISBN13))[0].format).toBe('Hardcover');
  expect(requests.length, 'a missing entry is refetched').toBe(2);
});

test('challenges and empty pages are never cached', async () => {
  const challengeCache = fakeCache();
  const first = scriptedFetch([
    response({ status: 202, url: `${BASE}/book/isbn/${ISBN13}`, body: WAF_CHALLENGE })
  ]);
  const challenged = makeProvider({
    fetchImpl: first.fetchImpl,
    gate: (task) => task(),
    cache: challengeCache
  });
  await expect(challenged.byIdentifier(ISBN13)).rejects.toThrow(GoodreadsChallengeError);
  expect(challengeCache.entries.size).toBe(0);

  const emptyCache = fakeCache();
  const empty = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: '   ' })
  });
  const emptyProvider = makeProvider({ fetchImpl: empty.fetchImpl, cache: emptyCache });
  expect(await emptyProvider.byIdentifier(ISBN13)).toEqual([]);
  expect(emptyCache.entries.size).toBe(0);
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

  expect(delays).toEqual([2500]);
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
  expect(genresFromBookPage(genrePageHtml)).toEqual([
    'Science Fiction',
    'Classics',
    'Audiobook'
  ]);
});

test('genresFromBookPage answers nothing for a page without the payload or genres', () => {
  expect(genresFromBookPage('<html><body>No such edition</body></html>')).toEqual([]);
  // The plain book page carries no `bookGenres` at all.
  expect(genresFromBookPage(bookPageHtml)).toEqual([]);
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

  expect(genres).toEqual(['Science Fiction', 'Classics', 'Audiobook']);
  expect(requests.map((request) => request.path), 'the Goodreads id wins over the ISBN').toEqual([`/book/show/${GOODREADS_ID}`]);
});

test('genresForEdition falls back to the ISBN route', async () => {
  const { requests, fetchImpl } = recorder({
    [`/book/isbn/${ISBN13}`]: (url) => response({ url, body: genrePageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  const genres = await provider.genresForEdition([{ issuer: 'isbn13', value: ISBN13 }]);

  expect(genres[0]).toBe('Science Fiction');
  expect(requests.map((request) => request.path)).toEqual([`/book/isbn/${ISBN13}`]);
});

test('genresForEdition never searches and answers nothing without a usable identifier', async () => {
  const { requests, fetchImpl } = recorder({
    '*': (url) => response({ url, body: genrePageHtml })
  });
  const provider = makeProvider({ fetchImpl });

  expect(await provider.genresForEdition([{ issuer: 'goodreads', value: '' }])).toEqual([]);
  expect(await provider.genresForEdition([])).toEqual([]);
  expect(await provider.genresForEdition()).toEqual([]);
  expect(requests.length, 'a fuzzy match on another book is worse than no genre').toBe(0);
});

test('genresForEdition answers nothing when the book page is missing', async () => {
  const { fetchImpl } = recorder({});
  const provider = makeProvider({ fetchImpl });

  expect(await provider.genresForEdition([{ issuer: 'goodreads', value: GOODREADS_ID }])).toEqual([]);
});
