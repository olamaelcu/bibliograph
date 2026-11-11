import { mergeCandidates, isbn13 as normalizeIsbn13, cleanString } from '../util.js';
import { createGoogleBooks } from './google-books.js';
import { createIsbndb } from './isbndb.js';
import { createGoodreads } from './goodreads.js';

const ISBN_ISSUERS = new Set(['isbn13', 'isbn10', 'isbn']);

export function createProviders({ pool, env = process.env, fetchImpl = fetch } = {}) {
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
    fetchImpl
  });
  const goodreads = createGoodreads({
    baseUrl: env.GOODREADS_BASE_URL || 'https://www.goodreads.com',
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
      candidates = await google.byIsbn(isbn);
      if (candidates.length === 0 && isbndb) candidates = await isbndb.byIsbn(isbn);
      if (candidates.length === 0) candidates = await goodreads.byIdentifier(isbn);
    }

    return mergeCandidates(candidates);
  }

  async function search(input) {
    const candidates = await google.search(input);
    if (candidates.length > 0) return mergeCandidates(candidates).slice(0, 10);

    const isbn = input.identifiers?.find((identifier) => ISBN_ISSUERS.has(identifier.issuer))
      ?.value;
    const text =
      [cleanString(input.q), cleanString(input.title), cleanString(input.author)]
        .filter(Boolean)
        .join(' ') || (isbn ? normalizeIsbn13(isbn) : undefined);

    if (isbndb && text) {
      const fromIsbndb = await isbndb.search((isbn && normalizeIsbn13(isbn)) || text);
      if (fromIsbndb.length > 0) return mergeCandidates(fromIsbndb).slice(0, 10);
    }

    if (text) return mergeCandidates(await goodreads.search(text)).slice(0, 10);
    return [];
  }

  return { resolve, search, providers: { google, isbndb, goodreads } };
}
