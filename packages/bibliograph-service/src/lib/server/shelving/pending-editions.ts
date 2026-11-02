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
import { bookUriFromValue } from './book-ref';
import { SHELVING_COLLECTION } from './shelvers';

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
    return bookUriFromValue(value) ?? catalogEditionUriFromRkey(rkey);
  }
  if (collection === BOOKHIVE_BOOK_COLLECTION) {
    // Bookhive keeps the reading status inline. A record that only rates a book
    // is not shelving, so it asks for nothing.
    const normalized = normalizeBookhiveBook(value);
    return normalized.shelf ? normalized.editionUri : null;
  }
  return null;
}
