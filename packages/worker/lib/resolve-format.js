/**
 * Resolve an edition's free-text `format` from Goodreads.
 *
 * The resolver is deliberately narrow: it normalises an operator-supplied
 * ISBN-10/13 list, asks only the Goodreads provider (never the fallback chain),
 * and returns the first non-empty candidate format. It performs no database or
 * outbox writes; the admin UI decides whether to apply the value.
 */

import { cleanString, isbn13 as normalizeIsbn13 } from './util.js';

export const MAX_FORMAT_ISBNS = 10;

function isbn13Checksum(digits) {
  let sum = 0;
  for (let index = 0; index < 13; index += 1) {
    sum += Number(digits[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

export class FormatResolveError extends Error {
  constructor(status, message, code = 'BadRequest') {
    super(message);
    this.name = 'FormatResolveError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Validate 1–10 ISBN-10/13 values, normalise to ISBN-13 and dedupe while
 * preserving order. A checksum failure is a 400, not a silently dropped row.
 */
export function normalizeFormatIsbns(value) {
  if (!Array.isArray(value)) {
    throw new FormatResolveError(400, 'isbns must be an array of ISBNs');
  }
  if (value.length === 0) {
    throw new FormatResolveError(400, 'at least one ISBN is required');
  }
  if (value.length > MAX_FORMAT_ISBNS) {
    throw new FormatResolveError(400, `at most ${MAX_FORMAT_ISBNS} ISBNs may be resolved`);
  }

  const seen = new Set();
  const isbns = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new FormatResolveError(400, 'each ISBN must be a non-empty string');
    }
    // `util.isbn13` only checks length for a 13-digit value; the resolver
    // additionally requires its check digit to match.
    const isbn = normalizeIsbn13(entry);
    if (!isbn || !isbn13Checksum(isbn)) {
      throw new FormatResolveError(400, 'every ISBN must be checksum-valid (ISBN-10 or ISBN-13)');
    }
    if (seen.has(isbn)) continue;
    seen.add(isbn);
    isbns.push(isbn);
  }
  return isbns;
}

/**
 * @param {{ providers: { goodreads?: { byIdentifier: (isbn: string) => Promise<object[]> } } }} providers
 * @param {string[]} isbns normalized, non-empty ISBN-13 list
 * @returns {Promise<{isbn: string, format: string, source: 'goodreads'} | null>}
 */
export async function resolveFormat(providers, isbns) {
  const goodreads = providers?.providers?.goodreads;
  if (!goodreads) {
    throw new FormatResolveError(502, 'Goodreads is not configured', 'ProviderUnavailable');
  }

  try {
    // Sequential on purpose: goodreads.js already gates its requests, and the
    // first ISBN with a format wins so later ISBNs cost nothing.
    for (const isbn of isbns) {
      const candidates = await goodreads.byIdentifier(isbn);
      for (const candidate of candidates ?? []) {
        const format = cleanString(candidate?.format);
        if (format) return { isbn, format, source: 'goodreads' };
      }
    }
    return null;
  } catch (error) {
    throw new FormatResolveError(
      502,
      'the Goodreads format lookup failed',
      'ProviderUnavailable'
    );
  }
}
