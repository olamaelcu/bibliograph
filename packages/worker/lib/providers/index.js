import { mergeCandidates, isbn13 as normalizeIsbn13, cleanString } from '../util.js';
import { createGoogleBooks } from './google-books.js';
import { createIsbndb } from './isbndb.js';
import { createGoodreads } from './goodreads.js';
import { parseDailyLimit } from './usage.js';

const ISBN_ISSUERS = new Set(['isbn13', 'isbn10', 'isbn']);

export function createProviders({
  pool,
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  isbndbDailyLimit
} = {}) {
  const google = createGoogleBooks({
    pool,
    apiKey: env.GOOGLE_BOOKS_API_KEY || undefined,
    baseUrl: env.GOOGLE_BOOKS_BASE_URL || 'https://www.googleapis.com/books/v1',
    fetchImpl
  });
  const isbndb = createIsbndb({
    pool,
    apiKey: env.ISBNDB_API_KEY || undefined,
    baseUrl: env.ISBNDB_BASE_URL || 'https://api2.isbndb.com',
    dailyLimit: isbndbDailyLimit ?? parseDailyLimit(env.ISBNDB_DAILY_LIMIT, logger),
    logger,
    fetchImpl
  });
  const goodreads = createGoodreads({
    baseUrl: env.GOODREADS_BASE_URL || 'https://www.goodreads.com',
    logger,
    fetchImpl
  });

  async function resolve(identifier) {
    const issuer = identifier.issuer.toLowerCase();
    let candidates = [];

    if (issuer === 'googlebooks' || issuer === 'google-books') {
      candidates = await google.byVolumeId(identifier.value);
    } else if (issuer === 'goodreads') {
      candidates = await goodreads.byId(identifier.value);
    } else if (ISBN_ISSUERS.has(issuer)) {
      const isbn = normalizeIsbn13(identifier.value);
      if (!isbn) return [];
      // ISBNdb owns the ISBN space; Google and Goodreads are fallbacks.
      if (isbndb) candidates = await isbndb.byIsbn(isbn);
      if (candidates.length === 0) candidates = await google.byIsbn(isbn);
      if (candidates.length === 0) candidates = await goodreads.byIdentifier(isbn);
    }

    return mergeCandidates(candidates);
  }

  async function search(input) {
    const isbn = input.identifiers?.find((identifier) => ISBN_ISSUERS.has(identifier.issuer))
      ?.value;
    const text =
      [cleanString(input.q), cleanString(input.title), cleanString(input.author)]
        .filter(Boolean)
        .join(' ') || (isbn ? normalizeIsbn13(isbn) : undefined);

    if (isbndb && text) {
      const isbn13 = isbn ? normalizeIsbn13(isbn) : null;
      const fromIsbndb = isbn13 ? await isbndb.byIsbn(isbn13) : await isbndb.search(text);
      if (fromIsbndb.length > 0) return mergeCandidates(fromIsbndb);
    }

    const fromGoogle = await google.search(input);
    if (fromGoogle.length > 0) return mergeCandidates(fromGoogle);

    if (text) return mergeCandidates(await goodreads.search(text));
    return [];
  }

  return { resolve, search, providers: { google, isbndb, goodreads } };
}
