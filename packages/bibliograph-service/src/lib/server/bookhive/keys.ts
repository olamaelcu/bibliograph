import { PUBLISHER_DID } from '../did';

/**
 * Bookhive (<https://bookhive.buzz>) is a reading tracker that publishes its
 * whole catalog and its users' book records on-protocol from a single PDS.
 *
 * Bibliograph consumes it the same way it consumes OpenLibrary / Google Books /
 * ISBNDb: `buzz.bookhive.catalogBook` records become
 * `community.lexicon.book.edition` rows keyed `bh.{hiveId}`, and the Bookhive
 * record's at-uri is carried as a `bookhive` identifier. That identifier is the
 * join key for reviews and shelving, because `buzz.bookhive.book` records
 * reference it through the `hiveBookUri` field (indexed by Constellation under
 * source `buzz.bookhive.book:hiveBookUri`).
 *
 * rkeys are synthesized (Bookhive has no OLID-style key) and validated
 * fail-closed so a `bh.` rkey can never collide with `ol.` / `gb.` / `isbndb.`.
 */

export const BOOKHIVE_DID = 'did:plc:enu2j5xjlqsjaylv3du4myh4';
export const BOOKHIVE_PDS = process.env.BOOKHIVE_PDS ?? 'https://bluesky.nickthesick.com';

export const BOOKHIVE_CATALOG_COLLECTION = 'buzz.bookhive.catalogBook';
export const BOOKHIVE_BOOK_COLLECTION = 'buzz.bookhive.book';
export const BOOKHIVE_BUZZ_COLLECTION = 'buzz.bookhive.buzz';

/**
 * Hive IDs look like `bk_Wf9C5GP9iEGH6hqNNtwW` and double as the PDS rkey of
 * the `catalogBook` record. They are dense (no dots, no slashes), which is what
 * makes them usable verbatim inside an rkey.
 */
const HIVE_ID_RE = /^bk_[A-Za-z0-9]{6,}$/;
const BH_PREFIX = 'bh.';

function assertHiveId(id: string): void {
  if (!HIVE_ID_RE.test(id)) throw new Error(`invalid bookhive hive id: ${id}`);
}

export function isHiveId(id: string): boolean {
  return HIVE_ID_RE.test(id);
}

export function bhEditionRkey(hiveId: string): string {
  assertHiveId(hiveId);
  return `${BH_PREFIX}${hiveId}`;
}

export function bhWorkRkey(hiveId: string): string {
  return bhEditionRkey(hiveId);
}

export function isBhRkey(rkey: string): boolean {
  if (!rkey.startsWith(BH_PREFIX)) return false;
  return HIVE_ID_RE.test(rkey.slice(BH_PREFIX.length));
}

export function bhEditionUri(hiveId: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.edition/${bhEditionRkey(hiveId)}`;
}

export function bhWorkUri(hiveId: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.work/${bhWorkRkey(hiveId)}`;
}

export function hiveIdFromBhRkey(rkey: string): string {
  if (!rkey.startsWith(BH_PREFIX)) throw new Error(`invalid bookhive rkey: ${rkey}`);
  const id = rkey.slice(BH_PREFIX.length);
  assertHiveId(id);
  return id;
}

/** at-uri of the Bookhive catalog record for a hive id — the review subject. */
export function bookhiveCatalogUri(hiveId: string): string {
  assertHiveId(hiveId);
  return `at://${BOOKHIVE_DID}/${BOOKHIVE_CATALOG_COLLECTION}/${hiveId}`;
}

/** Inverse of {@link bookhiveCatalogUri}; null for any other at-uri. */
export function hiveIdFromCatalogUri(uri: string): string | null {
  const prefix = `at://${BOOKHIVE_DID}/${BOOKHIVE_CATALOG_COLLECTION}/`;
  if (!uri.startsWith(prefix)) return null;
  const id = uri.slice(prefix.length);
  return isHiveId(id) ? id : null;
}

/** `bk.`-prefixed goodreads identifier for a catalog record's `sourceId`. */
export function goodreadsUri(sourceId: string): string {
  return `https://www.goodreads.com/book/show/${sourceId}`;
}
