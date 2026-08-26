import { PUBLISHER_DID } from '../did';

/**
 * ISBNDb has no native OLID-style key. We synthesize `isbndb.{isbn13}` (or
 * `isbndb.{isbn10}` when only that is available) rkeys and persist them under
 * the same PUBLISHER_DID. ISBNs are validated fail-closed: 10 or 13 digits
 * after stripping hyphens, reject `ol.*` and `gb.*`.
 */

const ISBNDB_RE = /^(?:\d{10}|\d{13})$/;
const ISBNDB_PREFIX = 'isbndb.';

function assertIsbndbId(id: string): void {
  if (!ISBNDB_RE.test(id)) throw new Error(`invalid isbndb id: ${id}`);
}

function stripHyphens(isbn: string): string {
  return isbn.replace(/-/g, '');
}

export function isIsbndbRkey(rkey: string): boolean {
  if (!rkey.startsWith(ISBNDB_PREFIX)) return false;
  return ISBNDB_RE.test(rkey.slice(ISBNDB_PREFIX.length));
}

function isbndbRkey(isbn: string): string {
  const clean = stripHyphens(isbn);
  assertIsbndbId(clean);
  return `${ISBNDB_PREFIX}${clean}`;
}

export function isbndbEditionRkey(isbn: string): string {
  return isbndbRkey(isbn);
}

export function isbndbWorkRkey(isbn: string): string {
  return isbndbRkey(isbn);
}

export function isbndbPublisherRkey(isbn: string): string {
  return isbndbRkey(isbn);
}

export function isbndbEditionUri(isbn: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.edition/${isbndbEditionRkey(isbn)}`;
}

export function isbndbWorkUri(isbn: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.work/${isbndbWorkRkey(isbn)}`;
}

export function isbnFromIsbndbRkey(rkey: string): string {
  if (!rkey.startsWith(ISBNDB_PREFIX)) throw new Error(`invalid isbndb rkey: ${rkey}`);
  const id = rkey.slice(ISBNDB_PREFIX.length);
  assertIsbndbId(id);
  return id;
}

export function isbndbIdentifierFromUri(uri: string): string | null {
  if (!uri.startsWith('https://api2.isbndb.com/book/')) return null;
  const raw = uri.slice('https://api2.isbndb.com/book/'.length);
  const clean = stripHyphens(raw);
  if (!ISBNDB_RE.test(clean)) return null;
  return clean;
}
