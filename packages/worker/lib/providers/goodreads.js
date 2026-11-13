import {
  createGate,
  cleanString,
  isbn13 as normalizeIsbn13,
  sleep as defaultSleep,
  stripHtml
} from '../util.js';
import { normalizeContributorRole } from '../contributor-roles.js';
import { fetchText } from './http.js';
import { backoffDelay } from './resilience.js';

const DEFAULT_BASE_URL = 'https://www.goodreads.com';
// Goodreads answers successful pages with `cache-control: public, max-age=86400`.
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 100;
/** Politeness gap between Goodreads requests, jittered so bursts are not clockwork. */
const DEFAULT_GATE_MS = 1000;
const DEFAULT_GATE_JITTER_MS = 1500;
/** A redirect loop is retried once, never retried in a loop of its own. */
const DEFAULT_REDIRECT_RETRIES = 1;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;
const CHALLENGE_SAMPLE_BYTES = 64 * 1024;
const PAGE_KINDS = new Set(['book', 'search']);

/**
 * Markers shared by AWS WAF (Goodreads' edge) and Cloudflare JS challenges.
 * Kept specific: a real book page or search results page contains none of
 * these strings, so a 200/403 body carrying one is a block rather than data.
 */
const CHALLENGE_MARKERS = new RegExp(
  [
    'awswaf',
    'aws-waf',
    'gokuProps',
    'challenge\\.js',
    'challenge-container',
    'AwsWafIntegration',
    'waf-challenge',
    'cf-browser-verification',
    'cf_chl_opt',
    'cf-challenge',
    '/cdn-cgi/challenge-platform/',
    'Attention Required! \\| Cloudflare',
    'Just a moment\\.\\.\\.',
    'Enable JavaScript and cookies to continue',
    'Checking your browser before accessing',
    'Verifying you are human'
  ].join('|'),
  'i'
);

// Book pages are served for `text/html`; adding `application/xhtml+xml` (or a
// long browser Accept) buys nothing and has been observed to feed the redirect
// loop below, so every profile asks for exactly this.
const BOOK_ACCEPT = 'text/html';
// `/search` is special: any Accept naming `text/html` (or `xhtml`) makes
// Goodreads answer 302 to the very same URL until the redirect limit trips.
// Only the bare wildcard is served, so search keeps `*/*`; every other header
// still looks like the rotating browser profile. Verified against the live
// WAF edge: `text/html`, `text/*`, xhtml and mixed lists all self-redirect.
const SEARCH_ACCEPT = '*/*';

/**
 * Coherent browser identities. Chromium profiles carry matching `sec-ch-ua`
 * values (same major version as the User-Agent and the same platform); Firefox
 * and Safari send no client hints, exactly like the real browsers.
 *
 * These profiles are cosmetic: a production probe found the AWS WAF decision
 * is per-IP volume, not UA/Accept/Sec-Fetch/cookies. They are kept because
 * they look like real traffic and never mix families, but WAF avoidance does
 * not rely on them.
 */
export const BROWSER_PROFILES = [
  {
    id: 'chrome-windows',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    acceptLanguage: 'en-US,en;q=0.9',
    chUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    chUaMobile: '?0',
    chUaPlatform: '"Windows"',
    accept: { book: BOOK_ACCEPT, search: SEARCH_ACCEPT },
    extraHeaders: { pragma: 'no-cache' }
  },
  {
    id: 'firefox-linux',
    userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    acceptLanguage: 'en-US,en;q=0.5',
    accept: { book: BOOK_ACCEPT, search: SEARCH_ACCEPT },
    extraHeaders: { pragma: 'no-cache', dnt: '1' }
  },
  {
    id: 'safari-macos',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    acceptLanguage: 'en-US,en;q=0.9',
    accept: { book: BOOK_ACCEPT, search: SEARCH_ACCEPT },
    extraHeaders: {}
  },
  {
    id: 'chrome-android',
    userAgent:
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/130.0.0.0 Mobile Safari/537.36',
    acceptLanguage: 'en-US,en;q=0.9',
    chUa: '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="24"',
    chUaMobile: '?1',
    chUaPlatform: '"Android"',
    accept: { book: BOOK_ACCEPT, search: SEARCH_ACCEPT },
    extraHeaders: { pragma: 'no-cache' }
  },
  {
    id: 'safari-ios',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    acceptLanguage: 'en-GB,en;q=0.9',
    accept: { book: BOOK_ACCEPT, search: SEARCH_ACCEPT },
    extraHeaders: {}
  }
];

/** Build the navigation headers for one page kind from one browser profile. */
export function profileHeaders(profile, { kind = 'book', referer } = {}) {
  if (!profile) throw new Error('profileHeaders requires a browser profile');
  if (!PAGE_KINDS.has(kind)) throw new Error(`unknown Goodreads page kind ${kind}`);

  const headers = {
    'user-agent': profile.userAgent,
    accept: profile.accept[kind],
    'accept-language': profile.acceptLanguage,
    'cache-control': 'max-age=0',
    'upgrade-insecure-requests': '1',
    'sec-fetch-site': referer ? 'same-origin' : 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-user': '?1',
    ...(referer ? { referer } : {}),
    ...(profile.chUa
      ? {
          'sec-ch-ua': profile.chUa,
          'sec-ch-ua-mobile': profile.chUaMobile,
          'sec-ch-ua-platform': profile.chUaPlatform
        }
      : {}),
    ...(profile.extraHeaders ?? {})
  };
  return headers;
}

/**
 * The WAF advertises its decision in `x-amzn-waf-action`; a 202 is always a
 * challenge and 403 bodies can be challenges too. Cloudflare answers 403 or a
 * 200 JS interstitial. Markers are checked against any page that has text so
 * a challenge is never mistaken for an empty (successful) page.
 */
export function isChallengePage(page) {
  if (!page) return false;
  const action = page.headers?.get?.('x-amzn-waf-action');
  if (typeof action === 'string' && /^(challenge|block)$/i.test(action.trim())) {
    return true;
  }
  if (page.status === 202) return true;
  const text = typeof page.text === 'string' ? page.text : page.body;
  if (typeof text !== 'string' || text === '') return false;
  return CHALLENGE_MARKERS.test(text.slice(0, CHALLENGE_SAMPLE_BYTES));
}

/** The WAF challenged/blocked the request; the resolver maps it to 502. */
export class GoodreadsChallengeError extends Error {
  constructor(url) {
    super(`goodreads answered an anti-bot challenge for ${url}`);
    this.name = 'GoodreadsChallengeError';
    this.code = 'GOODREADS_CHALLENGE';
    this.status = 502;
    this.retryable = true;
  }
}

/** `/search` redirected to itself until the fetch redirect limit tripped. */
export class GoodreadsRedirectLoopError extends Error {
  constructor(url) {
    super(`goodreads redirected ${url} to itself until the redirect limit tripped`);
    this.name = 'GoodreadsRedirectLoopError';
    this.code = 'GOODREADS_REDIRECT_LOOP';
    this.status = 502;
  }
}

/**
 * Bounded, TTL'd, process-local LRU of successfully fetched Goodreads HTML.
 * Each worker process keeps its own copy; nothing is shared across processes,
 * and challenges, errors and empty bodies are never inserted.
 */
export function createPageCache({
  ttlMs = DEFAULT_CACHE_TTL_MS,
  maxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  now = Date.now
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error('createPageCache requires a non-negative ttlMs');
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('createPageCache requires a positive integer maxEntries');
  }
  const entries = new Map();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      // Refresh recency so the eviction target is the least recently used page.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    }
  };
}

function role(value) {
  if (typeof value !== 'string') return normalizeContributorRole();
  const token = value.trim().toLowerCase().replace(/\s+/g, '-');
  return normalizeContributorRole(token);
}

function nextData(html) {
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

export function candidatesFromBookPage(html) {
  const data = nextData(html);
  const apollo = data?.props?.pageProps?.apolloState;
  if (!apollo) return [];

  const books = Object.values(apollo).filter(
    (value) => value?.__typename === 'Book' && cleanString(value.title)
  );
  const book = books.find((value) => value.details?.isbn13) ?? books[0];
  if (!book) return [];

  const identifiers = [];
  const legacyId = Number(book.legacyId);
  if (Number.isInteger(legacyId) && legacyId > 0) {
    identifiers.push({ issuer: 'goodreads', value: String(legacyId) });
  }
  const details = book.details ?? {};
  const isbn = normalizeIsbn13(details.isbn13 ?? details.isbn ?? '');
  if (isbn) identifiers.push({ issuer: 'isbn13', value: isbn });
  const asin = cleanString(details.asin);
  if (asin) identifiers.push({ issuer: 'asin', value: asin });
  if (identifiers.length === 0) return [];

  const candidate = {
    identifiers,
    title: cleanString(book.titleComplete) ?? cleanString(book.title),
    contributors: []
  };

  const contributorEdges = [book.primaryContributorEdge, ...(book.secondaryContributorEdges ?? [])];
  for (const edge of contributorEdges) {
    const contributor = edge?.node?.__ref ? apollo[edge.node.__ref] : undefined;
    const name = cleanString(contributor?.name);
    if (name) candidate.contributors.push({ name, role: role(edge.role) });
  }

  const description = stripHtml(book.description);
  if (description) candidate.description = description;
  const cover = cleanString(book.imageUrl);
  if (cover) candidate.coverUrl = cover;
  const pages = Number(details.numPages);
  if (Number.isInteger(pages) && pages > 0) candidate.pages = pages;
  const format = cleanString(details.format);
  if (format) candidate.format = format;
  const language = cleanString(details.language?.name);
  if (language) candidate.language = language;
  if (Number.isFinite(details.publicationTime)) {
    candidate.publishedDate = new Date(details.publicationTime).toISOString().slice(0, 10);
  }
  const publisher = cleanString(details.publisher);
  if (publisher) candidate.publisher = { name: publisher };

  const seriesEntry = book.bookSeries?.[0];
  const series = seriesEntry?.series?.__ref ? apollo[seriesEntry.series.__ref] : undefined;
  if (cleanString(series?.title)) {
    candidate.series = { name: series.title };
    if (cleanString(seriesEntry.userPosition)) candidate.series.position = seriesEntry.userPosition;
  }

  return [candidate];
}

export function candidatesFromSearchPage(html) {
  const rows = html.split(/<tr\s+itemscope/).slice(1);
  const candidates = [];

  for (const row of rows) {
    const id = /\/book\/show\/(\d+)/.exec(row)?.[1];
    const title = /class="bookTitle"[\s\S]*?<span[^>]*itemprop=['"]name['"][^>]*>([\s\S]*?)<\/span>/.exec(
      row
    )?.[1];
    if (!id || !title) continue;

    const identifiers = [{ issuer: 'goodreads', value: id }];
    const candidate = {
      identifiers,
      title: stripHtml(title),
      contributors: []
    };

    const author = /class="authorName"[\s\S]*?<span[^>]*itemprop=['"]name['"][^>]*>([\s\S]*?)<\/span>/.exec(
      row
    )?.[1];
    const authorName = stripHtml(author);
    if (authorName) {
      candidate.contributors.push({ name: authorName, role: normalizeContributorRole() });
    }

    const cover = /class="bookCover"[^>]*src="([^"]+)"/.exec(row)?.[1];
    if (cover) candidate.coverUrl = cover.replace(/^http:/, 'https:');

    if (candidate.title) candidates.push(candidate);
  }

  return candidates;
}

/** `fetch` reports a redirect-loop abort as a TypeError with this cause. */
function isRedirectLoop(error) {
  return [error?.message, error?.cause?.message, String(error?.cause ?? '')].some(
    (message) => typeof message === 'string' && /redirect count exceeded/i.test(message)
  );
}

export function createGoodreads({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  logger,
  now = Date.now,
  random = Math.random,
  sleep = defaultSleep,
  gateMs = DEFAULT_GATE_MS,
  gateJitterMs = DEFAULT_GATE_JITTER_MS,
  redirectRetries = DEFAULT_REDIRECT_RETRIES,
  retryBaseMs = DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_DELAY_MS,
  onBlocked,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  cache = createPageCache({ ttlMs: cacheTtlMs, maxEntries: cacheMaxEntries, now }),
  profiles = BROWSER_PROFILES,
  selectProfile,
  gate = createGate(gateMs, { jitterMs: gateJitterMs, random, sleepImpl: sleep })
} = {}) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error('createGoodreads requires at least one browser profile');
  }
  if (!Number.isInteger(redirectRetries) || redirectRetries < 0) {
    throw new Error('createGoodreads requires a non-negative integer redirectRetries');
  }
  const pickProfile = selectProfile ?? ((index) => profiles[index % profiles.length]);
  let profileCursor = 0;
  // A fresh browser session starts with a direct navigation (no Referer); a
  // follow-up search or retry looks like same-site navigation instead.
  let requested = false;

  function nextProfile() {
    const index = profileCursor % profiles.length;
    profileCursor += 1;
    return pickProfile(index) ?? profiles[index];
  }

  function headersFor(kind, attempt) {
    const referer = attempt > 1 || requested ? `${baseUrl}/` : undefined;
    requested = true;
    return profileHeaders(nextProfile(), { kind, referer });
  }

  /**
   * Fetch one page with a fresh browser profile.
   *
   * A WAF/Cloudflare challenge is never retried inline: repeated challenge
   * attempts only burn IP reputation, so it fails the logical request with a
   * distinguishable provider error and lets the caller fall through. A
   * self-redirect loop (explicit Accept on `/search`) is retried at most once,
   * because following it again cannot succeed. Consent walls (401/403 without
   * challenge markers) stay a non-retryable empty answer.
   *
   * The cache key is URL + page kind: the kind fixes the Accept variant that
   * produced the body. Profiles only change request headers, never the
   * representation, so they are deliberately not in the key; a per-profile
   * key would make the cache miss on every rotation.
   */
  async function get(path, kind = 'book') {
    const url = `${baseUrl}${path}`;
    const cacheKey = `${url}|${kind}`;
    const cached = cache?.get(cacheKey);
    if (cached) return cached;

    for (let attempt = 0; attempt <= redirectRetries; attempt += 1) {
      const headers = headersFor(kind, attempt + 1);
      let page;
      try {
        page = await gate(() =>
          fetchText(fetchImpl, url, { headers, readErrorBody: true })
        );
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          const blocked = isChallengePage({
            status: error.status,
            text: error.body,
            headers: error.headers
          });
          if (!blocked) return undefined;
          const challenge = new GoodreadsChallengeError(url);
          logger?.warn?.(`worker: goodreads WAF challenge (${error.status}) for ${url}`);
          onBlocked?.(challenge);
          throw challenge;
        }
        if (isRedirectLoop(error)) {
          if (attempt < redirectRetries) {
            logger?.warn?.(`worker: goodreads redirect loop for ${url}; retrying once`);
            await sleep(
              backoffDelay({
                attempt: attempt + 1,
                baseDelayMs: retryBaseMs,
                maxDelayMs: retryMaxMs,
                random
              })
            );
            continue;
          }
          const loop = new GoodreadsRedirectLoopError(url);
          logger?.warn?.(`worker: goodreads redirect loop for ${url}`);
          onBlocked?.(loop);
          throw loop;
        }
        throw error;
      }

      // A 404 is a normal "no such book" answer and is not cached.
      if (!page) return undefined;

      if (isChallengePage(page)) {
        const challenge = new GoodreadsChallengeError(url);
        logger?.warn?.(`worker: goodreads WAF challenge (${page.status}) for ${url}`);
        onBlocked?.(challenge);
        throw challenge;
      }

      if (typeof page.text === 'string' && page.text.trim() !== '') cache?.set(cacheKey, page);
      return page;
    }

    throw new GoodreadsRedirectLoopError(url);
  }

  async function searchResults(query) {
    const page = await get(`/search?q=${encodeURIComponent(query)}`, 'search');
    if (!page) return [];
    return /\/book\/show\//.test(new URL(page.url).pathname)
      ? candidatesFromBookPage(page.text)
      : candidatesFromSearchPage(page.text);
  }

  return {
    /** Exposed for introspection and tests; process-local, not shared. */
    cache,

    async byId(id) {
      const page = await get(`/book/show/${encodeURIComponent(id)}`);
      return page ? candidatesFromBookPage(page.text) : [];
    },

    async byIdentifier(value) {
      // ISBNs resolve straight to the book page; anything else (a legacy
      // numeric Goodreads id, a title) keeps the search behavior.
      const isbn = normalizeIsbn13(value);
      if (isbn) {
        const page = await get(`/book/isbn/${isbn}`);
        const candidates = page ? candidatesFromBookPage(page.text) : [];
        if (candidates.length > 0) return candidates;
      }
      return searchResults(isbn ?? value);
    },

    async search(text) {
      const page = await get(`/search?q=${encodeURIComponent(text)}`, 'search');
      if (!page) return [];
      return [candidatesFromBookPage(page.text), candidatesFromSearchPage(page.text)].flat();
    }
  };
}
