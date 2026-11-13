import { mergeCandidates, isbn13 as normalizeIsbn13, cleanString } from '../util.js';
import { createGoogleBooks } from './google-books.js';
import { createIsbndb } from './isbndb.js';
import { createOpenLibrary } from './openlibrary.js';
import { createGoodreads } from './goodreads.js';
import { createGutenberg } from './gutenberg.js';
import { parseDailyLimit } from './usage.js';
import { createProviderHttp, createProviderMetrics } from './resilience.js';

const ISBN_ISSUERS = new Set(['isbn13', 'isbn10', 'isbn']);

export function createProviders({
  pool,
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  isbndbDailyLimit,
  providerMetrics,
  resilience = {}
} = {}) {
  const metrics = providerMetrics ?? createProviderMetrics();
  const googleHttp = createProviderHttp({
    ...resilience,
    provider: 'googlebooks',
    fetchImpl,
    metrics
  });
  const isbndbHttp = createProviderHttp({
    ...resilience,
    provider: 'isbndb',
    fetchImpl,
    metrics
  });
  const openlibraryHttp = createProviderHttp({
    ...resilience,
    provider: 'openlibrary',
    fetchImpl,
    metrics
  });
  const gutenbergHttp = createProviderHttp({
    ...resilience,
    provider: 'gutenberg',
    fetchImpl,
    metrics
  });
  const goodreadsHttp = createProviderHttp({
    ...resilience,
    provider: 'goodreads',
    fetchImpl,
    metrics,
    // Goodreads' WAF is per-IP volume: a blocked publisher gets a longer
    // cooldown than the shared default, and genuine 429/5xx/timeout retries
    // use a slower ladder (3 attempts, ~1 s base, 8 s cap).
    cooldownMs: resilience.cooldownMs ?? 60_000,
    baseDelayMs: resilience.baseDelayMs ?? 1_000,
    maxDelayMs: resilience.maxDelayMs ?? 8_000
  });
  const google = createGoogleBooks({
    pool,
    apiKey: env.GOOGLE_BOOKS_API_KEY || undefined,
    baseUrl: env.GOOGLE_BOOKS_BASE_URL || 'https://www.googleapis.com/books/v1',
    fetchImpl: googleHttp.fetch
  });
  const isbndb = createIsbndb({
    pool,
    apiKey: env.ISBNDB_API_KEY || undefined,
    baseUrl: env.ISBNDB_BASE_URL || 'https://api2.isbndb.com',
    dailyLimit: isbndbDailyLimit ?? parseDailyLimit(env.ISBNDB_DAILY_LIMIT, logger),
    logger,
    fetchImpl: isbndbHttp.fetch,
    breaker: isbndbHttp.breaker
  });
  const openlibrary = createOpenLibrary({
    baseUrl: env.OPENLIBRARY_BASE_URL || 'https://openlibrary.org',
    fetchImpl: openlibraryHttp.fetch
  });
  const gutenberg = createGutenberg({
    baseUrl: env.GUTENBERG_BASE_URL || 'https://www.gutenberg.org',
    fetchImpl: gutenbergHttp.fetch
  });
  const goodreads = createGoodreads({
    baseUrl: env.GOODREADS_BASE_URL || 'https://www.goodreads.com',
    logger,
    fetchImpl: goodreadsHttp.fetch,
    // A recognized challenge/block opens the breaker so the next request
    // short-circuits instead of hitting the WAF again.
    onBlocked: () => goodreadsHttp.breaker.trip()
  });

  /**
   * Walk providers in priority order until one returns candidates. A provider
   * that throws (outage, open breaker) is logged and skipped so the rest of the
   * chain still answers; if every step is empty and at least one threw, the
   * first error is rethrown instead of reporting a misleading empty success.
   */
  async function firstCandidates(label, steps) {
    const errors = [];
    for (const [provider, run] of steps) {
      try {
        const candidates = await run();
        if (candidates.length > 0) return candidates;
      } catch (error) {
        errors.push(error);
        logger?.warn?.(`worker: ${provider} failed for ${label} — ${error.message}`);
      }
    }
    if (errors.length > 0) throw errors[0];
    return [];
  }

  async function resolve(identifier) {
    const issuer = identifier.issuer.toLowerCase();

    if (issuer === 'googlebooks' || issuer === 'google-books') {
      return mergeCandidates(await google.byVolumeId(identifier.value));
    }
    if (issuer === 'goodreads') {
      return mergeCandidates(await goodreads.byId(identifier.value));
    }
    if (issuer === 'openlibrary') {
      return mergeCandidates(await openlibrary.byIdentifier(identifier.value));
    }
    // Public-domain ebooks are their own editions, so this resolves one ebook
    // by id rather than joining the ISBN chain above.
    if (issuer === 'gutenberg' || issuer === 'pg' || issuer === 'project-gutenberg') {
      return mergeCandidates(await gutenberg.byId(identifier.value));
    }
    if (!ISBN_ISSUERS.has(issuer)) return [];

    const isbn = normalizeIsbn13(identifier.value);
    if (!isbn) return [];

    // ISBNdb owns the ISBN space; Google Books and Goodreads follow, and the
    // keyless OpenLibrary API is the final fallback. The breaker lets an open
    // ISBNdb skip straight to the rest.
    const steps = [];
    if (isbndb) steps.push(['isbndb', () => isbndb.byIsbn(isbn)]);
    steps.push(['googlebooks', () => google.byIsbn(isbn)]);
    steps.push(['goodreads', () => goodreads.byIdentifier(isbn)]);
    steps.push(['openlibrary', () => openlibrary.byIsbn(isbn)]);
    return mergeCandidates(await firstCandidates(`isbn:${isbn}`, steps));
  }

  async function search(input) {
    const isbn = input.identifiers?.find((identifier) => ISBN_ISSUERS.has(identifier.issuer))
      ?.value;
    const text =
      [cleanString(input.q), cleanString(input.title), cleanString(input.author)]
        .filter(Boolean)
        .join(' ') || (isbn ? normalizeIsbn13(isbn) : undefined);

    const isbn13 = isbn ? normalizeIsbn13(isbn) : null;
    const steps = [];
    if (isbndb && text) {
      steps.push(['isbndb', () => (isbn13 ? isbndb.byIsbn(isbn13) : isbndb.search(text))]);
    }
    steps.push(['googlebooks', () => google.search(input)]);
    if (text) steps.push(['goodreads', () => goodreads.search(text)]);
    if (text) steps.push(['openlibrary', () => openlibrary.search(input)]);
    return mergeCandidates(await firstCandidates(text ?? 'search', steps));
  }

  return {
    resolve,
    search,
    providers: { google, isbndb, openlibrary, goodreads, gutenberg },
    metrics,
    resilience: {
      googlebooks: googleHttp.breaker,
      isbndb: isbndbHttp.breaker,
      openlibrary: openlibraryHttp.breaker,
      goodreads: goodreadsHttp.breaker,
      gutenberg: gutenbergHttp.breaker
    }
  };
}
