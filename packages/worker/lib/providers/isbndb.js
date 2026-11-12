import { createGate, isbn13 as normalizeIsbn13, cleanString, stripHtml } from '../util.js';
import { createJsonCache, fetchJson } from './http.js';
import {
  DEFAULT_ISBNDB_DAILY_LIMIT,
  parseDailyLimit,
  reserveDailyCall
} from './usage.js';

const gate = createGate(1000);

// ISBNdb sometimes returns a publisher blurb as one quoted citation:
//   "Body."--Back cover.
//   “Body.”—Kirkus Reviews
// The quote marks and the trailing attribution are payload formatting, not
// part of the synopsis. Only a value that is wholly one quoted citation is
// unwrapped; unquoted descriptions and interior quotes are left untouched.
// The attribution must be a single source line: sentence punctuation means the
// value continues with real synopsis text after the blurb and must stay whole.
// A source is also short (at most eight words); a longer tail is a following
// synopsis, not an attribution.
const QUOTED_CITATION =
  /^["“](.+?)["”](?:\s*(?:--|—|–)\s*[^\s.!?"“”]+(?:\s+[^\s.!?"“”]+){0,7}\.?)?$/u;
// A body containing its own closing quote followed by an attribution marker is
// several concatenated citations, not one quoted citation. Leave it alone
// rather than stripping the outer quotes and a later attribution.
const INTERNAL_ATTRIBUTION = /["”]\s*(?:--|—|–)/u;

// Concatenated citations can also be adjacent quoted segments with no dash
// attribution between them. A single quoted body may contain balanced interior
// quotes, so reject any body whose quote marks do not pair up.
function hasBalancedQuotes(value) {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '“') {
      depth += 1;
    } else if (char === '”') {
      if (depth === 0) return false;
      depth -= 1;
    } else if (char === '"') {
      // Straight quotes serve as both delimiters. A quote after whitespace or
      // an opening bracket and before a word opens; otherwise it closes.
      const previous = value[index - 1] ?? ' ';
      const next = value[index + 1] ?? ' ';
      const opens = /[\s([{—–-]/.test(previous) && !/[\s.,;:!?)]/.test(next);
      if (opens) {
        depth += 1;
      } else {
        if (depth === 0) return false;
        depth -= 1;
      }
    }
  }
  return depth === 0;
}

export function cleanIsbndbSynopsis(value) {
  const text = stripHtml(value);
  if (!text) return undefined;

  const match = QUOTED_CITATION.exec(text);
  if (!match || INTERNAL_ATTRIBUTION.test(match[1]) || !hasBalancedQuotes(match[1])) {
    return text;
  }

  const body = match[1].trim();
  return body === '' ? text : body;
}

export function candidateFromIsbndb(book) {
  if (!book || !cleanString(book.title)) return undefined;

  const identifiers = [];
  const isbn13 = normalizeIsbn13(book.isbn13 ?? book.isbn ?? '');
  if (isbn13) identifiers.push({ issuer: 'isbn13', value: isbn13 });
  if (identifiers.length === 0) return undefined;

  const candidate = {
    identifiers,
    title: cleanString(book.title),
    contributors: [...new Set((book.authors ?? []).map(cleanString).filter(Boolean))].map((name) => ({
      name,
      role: 'author'
    }))
  };

  const subtitle = cleanString(book.title_long)?.replace(`${candidate.title}:`, '').trim();
  if (subtitle) candidate.subtitle = subtitle;
  const language = cleanString(book.language);
  if (language) candidate.language = language;
  const publishedDate = cleanString(book.date_published);
  if (publishedDate) candidate.publishedDate = publishedDate;
  const pages = Number(book.pages);
  if (Number.isInteger(pages) && pages > 0) candidate.pages = pages;
  const description = cleanIsbndbSynopsis(book.synopsis);
  if (description) candidate.description = description;
  const cover = cleanString(book.image);
  if (cover) candidate.coverUrl = cover.replace(/^http:/, 'https:');
  const publisher = cleanString(book.publisher);
  if (publisher) candidate.publisher = { name: publisher };

  return candidate;
}

export function createIsbndb({
  pool,
  apiKey,
  baseUrl,
  dailyLimit = DEFAULT_ISBNDB_DAILY_LIMIT,
  fetchImpl = fetch,
  logger = console,
  breaker
}) {
  if (!apiKey) return null;
  // The daily cap cannot be enforced without the shared counter, and an
  // unenforced metered provider is worse than a loud configuration error.
  if (!pool) throw new Error('createIsbndb requires a Postgres pool for daily quota accounting');

  const limit = parseDailyLimit(dailyLimit, logger);
  const cache = createJsonCache(pool, 'isbndb_cache');
  const headers = { authorization: apiKey, accept: 'application/json' };
  // Warn at most once per process per UTC day: an exhausted quota lasts until
  // midnight UTC, so repeating it on every miss would drown the log.
  let exhaustedDay;

  // Metered providers must not spend a daily call on a request an open
  // breaker would reject. This check is read-only; the resilient fetch below
  // still owns the half-open probe transition.
  function assertProviderAvailable() {
    breaker?.assertCanAttempt?.();
  }

  async function query(url) {
    assertProviderAvailable();
    const cached = await cache.get(url);
    if (cached !== undefined) return cached;

    // Reserve before the request: failed attempts still count (billing and
    // attempt semantics), and concurrent workers cannot exceed the limit.
    const calls = await reserveDailyCall(pool, { limit });
    if (calls === null) {
      const day = new Date().toISOString().slice(0, 10);
      if (exhaustedDay !== day) {
        exhaustedDay = day;
        logger?.warn?.(
          `worker: ISBNdb daily quota exhausted (${limit} calls per UTC day); ` +
            'skipping the network and falling back to Google Books/Goodreads'
        );
      }
      return undefined;
    }

    const body = await gate(() => fetchJson(fetchImpl, url, { headers }));
    if (body !== undefined) await cache.put(url, url, body);
    return body;
  }

  return {
    async byIsbn(isbn) {
      const body = await query(`${baseUrl}/book/${encodeURIComponent(isbn)}`);
      return [candidateFromIsbndb(body?.book)].filter(Boolean);
    },

    async search(text) {
      // pageSize is documented for /books/{query}; the API caps it at 100.
      const body = await query(`${baseUrl}/books/${encodeURIComponent(text)}?pageSize=50`);
      return (body?.books ?? []).map(candidateFromIsbndb).filter(Boolean);
    }
  };
}
