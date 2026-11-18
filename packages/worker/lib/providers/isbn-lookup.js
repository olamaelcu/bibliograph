/**
 * Find an ISBN for an edition that has none, from the providers that do not
 * meter.
 *
 * The ingest chain starts at ISBNdb, which is metered (`provider_daily_usage`);
 * this lookup deliberately does not. It is run over a hundred-thousand-book
 * backlog, so it asks the free providers in order and stops at the first title
 * match that carries an ISBN:
 *
 *   1. OpenLibrary search — its `/search.json` documents carry every ISBN the
 *      work's editions have.
 *   2. Goodreads search — a result row carries no ISBN, only the numeric book
 *      id, so the matched row's book page is read to get one.
 *   3. Google Books search — last because it is keyed and rate-gated, and it
 *      answers worse for old catalogue books than the two above.
 *
 * ISBNdb is never imported here; that is the whole point of the module.
 *
 * ## The title rule
 *
 * A provider's search is fuzzy, so a candidate is only accepted when *both* of
 * these hold against the catalog title, after normalising case, diacritics,
 * whitespace and punctuation:
 *
 *   * **opening match** — the first `min(20, len(reference), len(candidate))`
 *     characters are equal, i.e. the first twenty characters match, or the
 *     shorter title is a prefix of the longer when either is shorter than
 *     twenty;
 *   * **token overlap** — at least 80% of the reference title's tokens appear
 *     in the candidate title (`TOKEN_OVERLAP`).
 *
 * Either test alone admits a known trap. The twenty-character opening admits
 * `Harry Potter and the Philosopher's Stone` → `Harry Potter and the Chamber of
 * Secrets` (they share their first twenty characters); the token test alone
 * admits any book that happens to repeat most of the reference's words in a
 * different order. Requiring both is the stricter reading, and it still accepts
 * the near matches a provider really returns — a series suffix, a subtitle, a
 * missing leading article.
 *
 * Among the candidates that pass, the best is chosen by: exact normalised
 * title, then token overlap, then the shortest title (the one carrying the
 * least extra text). `Array#sort` is stable, so provider order breaks the last
 * tie.
 */

import { cleanString, isbn13 as normalizeIsbn13 } from '../util.js';

/** Characters of the two titles that must agree before tokens are counted. */
export const OPENING_CHARS = 20;
/** Share of the reference title's tokens the candidate must repeat. */
export const TOKEN_OVERLAP = 0.8;

/** Words that mark a trailing segment as a format/series note, not an author. */
const EDITION_NOISE =
  /\b(edition|deluxe|annotated|illustrated|box|boxed|set|series|volume|vol|omnibus|collection|complete|unabridged)\b/i;

/**
 * The title to ask a provider for.
 *
 * Catalog titles arrive dirty from the feeds: `Neuromancer - William Gibson`,
 * `The Left Hand of Darkness by Ursula K. Le Guin`, `Dune (Dune Chronicles,
 * #1)`. A search for the raw string finds nothing — OpenLibrary answered
 * `numFound: 0` for the first of those — because the trailing author and series
 * notes are not part of the title index. The suffix is dropped only when it
 * looks like a person's name (or a parenthetical), so `Dune - Deluxe Edition`
 * keeps its suffix and cannot resolve to the base edition's ISBN.
 */
export function titleForLookup(value) {
  let text = cleanString(value) ?? '';
  text = text.replace(/\s*\([^()]*\)\s*$/, '').trim();

  const separator = /^(.*\S)\s+(?:[-–—|]|\bby\b)\s+(.+)$/i.exec(text);
  if (separator) {
    const head = separator[1].trim();
    const tail = separator[2].trim();
    const words = tail.split(/\s+/);
    const looksLikeName =
      words.length >= 2 &&
      words.length <= 4 &&
      words.every((word) => /^\p{Lu}/u.test(word)) &&
      !/[0-9]/.test(tail) &&
      !EDITION_NOISE.test(tail);
    if (head.length >= 3 && looksLikeName) text = head;
  }

  return text;
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normaliseTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(normalised) {
  return normalised === '' ? [] : normalised.split(' ');
}

/**
 * Share of the reference title's tokens that the candidate repeats.
 *
 * Measured against the reference, not the union: a provider title that appends
 * a series name or a subtitle is still the same book, while one that drops a
 * word from the reference is not.
 */
export function titleOverlap(reference, candidate) {
  const referenceTokens = tokens(normaliseTitle(reference));
  if (referenceTokens.length === 0) return 0;
  const candidateTokens = new Set(tokens(normaliseTitle(candidate)));
  const shared = referenceTokens.filter((token) => candidateTokens.has(token)).length;
  return shared / referenceTokens.length;
}

/** True when the first twenty characters agree (or the shorter title is a prefix). */
export function sharesOpening(reference, candidate) {
  const left = normaliseTitle(reference);
  const right = normaliseTitle(candidate);
  const width = Math.min(OPENING_CHARS, left.length, right.length);
  return width > 0 && left.slice(0, width) === right.slice(0, width);
}

/** The documented acceptance rule: opening match *and* token overlap. */
export function titlesMatch(reference, candidate) {
  return sharesOpening(reference, candidate) && titleOverlap(reference, candidate) >= TOKEN_OVERLAP;
}

function comparator(reference) {
  const exact = normaliseTitle(reference);
  return (left, right) => {
    const leftExact = normaliseTitle(left.title) === exact ? 1 : 0;
    const rightExact = normaliseTitle(right.title) === exact ? 1 : 0;
    if (leftExact !== rightExact) return rightExact - leftExact;

    const overlap = titleOverlap(reference, right.title) - titleOverlap(reference, left.title);
    if (overlap !== 0) return overlap;

    return normaliseTitle(left.title).length - normaliseTitle(right.title).length;
  };
}

/**
 * The candidates that pass the title rule, best first.
 *
 * Exported for the tests (and for an operator reading `node -e`): the picker is
 * a pure function of the reference title and the provider's answer.
 */
export function rankTitleMatches(reference, candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => cleanString(candidate?.title) !== undefined)
    .filter((candidate) => titlesMatch(reference, candidate.title))
    .slice()
    .sort(comparator(reference));
}

/** The first ranked candidate that names an ISBN, or `undefined`. */
function firstWithIsbn(reference, candidates) {
  for (const candidate of rankTitleMatches(reference, candidates)) {
    const isbn13 = isbnFromCandidate(candidate);
    if (isbn13) return { candidate, isbn13 };
  }
  return undefined;
}

/**
 * The ISBN-10 form of a 978-prefixed ISBN-13, or `null` when there is none (a
 * 979 ISBN has no ten-digit form).
 *
 * The catalog stores both issuers — `isbn10` rows exist — so "does another
 * edition own this ISBN" has to ask about both spellings of the same book.
 */
export function isbn10FromIsbn13(value) {
  const isbn = normalizeIsbn13(cleanString(value));
  if (!isbn || !isbn.startsWith('978')) return null;
  const core = isbn.slice(3, 12);
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(core[index]) * (10 - index);
  const check = (11 - (sum % 11)) % 11;
  return `${core}${check === 10 ? 'X' : check}`;
}

/** The candidate's ISBN, normalised to thirteen digits; `null` when it has none. */
export function isbnFromCandidate(candidate) {
  for (const identifier of Array.isArray(candidate?.identifiers) ? candidate.identifiers : []) {
    const issuer = cleanString(identifier?.issuer)?.toLowerCase();
    if (issuer !== 'isbn13' && issuer !== 'isbn10' && issuer !== 'isbn') continue;
    const isbn = normalizeIsbn13(cleanString(identifier?.value));
    if (isbn) return isbn;
  }
  return null;
}

function goodreadsId(candidate) {
  for (const identifier of Array.isArray(candidate?.identifiers) ? candidate.identifiers : []) {
    if (cleanString(identifier?.issuer)?.toLowerCase() !== 'goodreads') continue;
    const value = cleanString(identifier?.value);
    if (value) return value;
  }
  return undefined;
}

/**
 * Look up the ISBN of one book through the free providers, in order.
 *
 * Returns `{ isbn13, source, candidate }` or `null`. A provider that throws is
 * logged and skipped while another still has a chance; when every provider
 * threw, the first error is rethrown so the job retries instead of filing a
 * misleading "no ISBN".
 *
 * `providers` is the provider registry's `.providers` object (openlibrary,
 * goodreads, google). A missing provider is a skipped step, which is how a
 * caller with a partial registry (a test, a script) stays useful.
 */
export async function lookupIsbn({
  providers,
  title,
  authors = [],
  identifiers = [],
  logger
} = {}) {
  // Both the query and the match use the cleaned title: a provider cannot find
  // `Neuromancer - William Gibson`, and a candidate found for `Neuromancer`
  // would fail the opening rule against the raw string.
  const reference = titleForLookup(title);
  if (!reference) return null;

  const author = (Array.isArray(authors) ? authors : [])
    .map((name) => cleanString(name))
    .filter(Boolean)
    .join(' ');
  const query = { title: reference, author: author || undefined, identifiers };
  const text = [reference, author].filter(Boolean).join(' ');

  async function fromOpenLibrary() {
    return firstWithIsbn(reference, await providers.openlibrary.search(query));
  }

  async function fromGoodreads() {
    const results = await providers.goodreads.search(text);
    const best = rankTitleMatches(reference, results)[0];
    if (!best) return undefined;
    // A search row carries the Goodreads id but no ISBN; the book page is the
    // record that names one. The page's title is re-checked, because the row
    // that matched was only a search snippet.
    const id = goodreadsId(best);
    if (!id) return firstWithIsbn(reference, results);
    return firstWithIsbn(reference, await providers.goodreads.byId(id));
  }

  async function fromGoogle() {
    return firstWithIsbn(reference, await providers.google.search(query));
  }

  const steps = [];
  if (typeof providers?.openlibrary?.search === 'function') {
    steps.push(['openlibrary', fromOpenLibrary]);
  }
  if (typeof providers?.goodreads?.search === 'function') {
    steps.push(['goodreads', fromGoodreads]);
  }
  if (typeof providers?.google?.search === 'function') {
    steps.push(['googlebooks', fromGoogle]);
  }

  const errors = [];
  for (const [source, run] of steps) {
    try {
      const found = await run();
      if (found) return { isbn13: found.isbn13, source, candidate: found.candidate };
    } catch (error) {
      errors.push(error);
      logger?.warn?.(
        `isbn-lookup: ${source} failed for "${reference}" — ${error?.message ?? error}`
      );
    }
  }
  if (steps.length > 0 && errors.length === steps.length) throw errors[0];
  return null;
}
