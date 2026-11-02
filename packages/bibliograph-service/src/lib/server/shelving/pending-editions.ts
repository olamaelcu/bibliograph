// Which catalog edition a mirrored record points at, so the ingest path can ask
// for it to be filled.
//
// The tap consumer mirrors records; it does not own the catalog. A shelving
// record for an edition nobody has ingested leaves the reader's shelf looking
// empty, because `hydrateBookShelves` drops books it cannot resolve. The upsert
// path therefore asks this module what a record implies, checks whether the
// edition is present, and enqueues a fill for anything missing.
//
// Only records that actually put a book on a shelf count: a review or a rating
// is not a shelf decision, and filling the catalog from every review is a much
// larger job than the one this answers.

import { BOOKHIVE_BOOK_COLLECTION } from '../bookhive/keys';
import { normalizeBookhiveBook } from '../bookhive/records';
import { catalogEditionUriFromRkey } from './catalog-uri';
import { SHELVING_COLLECTION } from './shelvers';

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `book` is a strongRef in the lexicon, but writers have stored a bare at-uri
 * too, so both shapes are read. The ref wins over the rkey: it names the edition
 * the record actually points at.
 */
function bookRefUri(record: Record<string, unknown>): string | null {
  const book = record.book;
  if (typeof book === 'string' && book.startsWith('at://')) return book;
  if (book !== null && typeof book === 'object' && 'uri' in book) {
    const uri = book.uri;
    if (typeof uri === 'string' && uri.startsWith('at://')) return uri;
  }
  return null;
}

/**
 * Catalog edition URI a mirrored record implies, or `null` when the record does
 * not put a book on a shelf (or names an edition this build cannot address).
 */
export function catalogUriForMirroredRecord(
  collection: string,
  rkey: string,
  value: unknown,
): string | null {
  if (collection === SHELVING_COLLECTION) {
    // Older bookShelving records predate the `book` ref; their rkey is the
    // edition rkey, which is what `bookUriForRow` falls back to as well.
    return bookRefUri(asObject(value)) ?? catalogEditionUriFromRkey(rkey);
  }
  if (collection === BOOKHIVE_BOOK_COLLECTION) {
    // Bookhive keeps the reading status inline. A record that only rates a book
    // is not shelving, so it asks for nothing.
    const normalized = normalizeBookhiveBook(value);
    return normalized.shelf ? normalized.editionUri : null;
  }
  return null;
}
