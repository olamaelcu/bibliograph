import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { records } from '../db/schema';
import { BOOKHIVE_BOOK_COLLECTION, BOOKHIVE_DID } from '../bookhive/keys';
import { SHELVING_COLLECTION } from './shelvers';

/**
 * The two collections that put a book on a reader's shelf.
 *
 * Livtet writes a `bookShelving` record per (reader, book, shelf); Bookhive folds
 * the shelf into the reader's own copy of the book, so a `buzz.bookhive.book`
 * record *is* the shelving row. Every shelf read has to select both, or half the
 * network's shelving is invisible.
 */
export const SHELF_SOURCE_COLLECTIONS = [SHELVING_COLLECTION, BOOKHIVE_BOOK_COLLECTION] as const;

/**
 * Bookhive's reading status per Livtet shelf rkey. The rkey is what
 * `bookShelving.shelf` ends with, so a shelf URI names its status without a
 * second read.
 */
export const BOOKHIVE_STATUS_BY_SHELF_RKEY: Record<string, string> = {
  reading: 'buzz.bookhive.defs#reading',
  read: 'buzz.bookhive.defs#finished',
  'to-read': 'buzz.bookhive.defs#wantToRead',
  dnf: 'buzz.bookhive.defs#abandoned',
};

/** Shelf rkey (`reading`, `read`, `to-read`, `dnf`) a shelf URI names. */
export function shelfRkeyOf(shelfUri: string): string {
  const end = shelfUri.lastIndexOf('/');
  return end === -1 ? '' : shelfUri.slice(end + 1);
}

/** Bookhive status token for a shelf rkey, or null when the shelf has no peer. */
export function bookhiveStatusForShelfRkey(rkey: string): string | null {
  return BOOKHIVE_STATUS_BY_SHELF_RKEY[rkey] ?? null;
}

/**
 * Shelf rkey a Bookhive status belongs on, or null for a status this app does
 * not have a shelf for. The inverse of `BOOKHIVE_STATUS_BY_SHELF_RKEY`, for
 * grouping a mixed page by shelf when only the record's own value is in hand.
 */
export function shelfRkeyForBookhiveStatus(status: unknown): string | null {
  if (typeof status !== 'string') return null;
  for (const [rkey, token] of Object.entries(BOOKHIVE_STATUS_BY_SHELF_RKEY)) {
    if (token === status) return rkey;
  }
  return null;
}

/**
 * JSON expression for the Bookhive catalog record a user's book points at.
 *
 * Bookhive records the subject as `hiveBookUri` in newer writes and as a bare
 * `hiveId` in older ones. `normalizeBookhiveBook` folds both, and this is the
 * same fold in SQL — the join key for "who else shelved this book", which has no
 * `book` ref to match on.
 */
export function bookhiveSubjectSql(): SQL {
  return sql`coalesce(${records.value}->>'hiveBookUri', ${`at://${BOOKHIVE_DID}/buzz.bookhive.catalogBook/`} || (${records.value}->>'hiveId'))`;
}

export interface ShelfEntryOptions {
  /** Shelf URIs to match. Empty means every shelf of both apps. */
  shelfUris?: readonly string[];
  /** Restrict to one reader's shelf. */
  did?: string;
  /** Restrict to one book, by its Bookhive catalog subject. */
  bookhiveSubject?: string | null;
  /** Restrict to one book, by the edition uri a Livtet record carries. */
  bookUri?: string;
  /** Which app's records to read. Defaults to both. */
  apps?: readonly ('shelving' | 'bookhive')[];
}

/**
 * `WHERE` for "a book on a shelf", spanning both apps.
 *
 * A `bookShelving` row carries `shelf` and `book.uri`; a `buzz.bookhive.book`
 * row carries neither — its shelf is the inline `status` token and its book is
 * the catalog subject. Folding both shapes here keeps each handler's own SQL to
 * one condition instead of forking the whole query per app.
 */
export function shelfEntryConditions(opts: ShelfEntryOptions = {}): SQL {
  const { shelfUris, did, bookhiveSubject, bookUri, apps } = opts;
  const wantNative = !apps || apps.includes('shelving');
  const wantBookhive = !apps || apps.includes('bookhive');
  const statuses = shelfUris
    ? Array.from(new Set(shelfUris.map((uri) => bookhiveStatusForShelfRkey(shelfRkeyOf(uri)))))
        .filter((status): status is string => status !== null)
    : [];

  const native = wantNative
    ? and(
        eq(records.collection, SHELVING_COLLECTION),
        shelfUris && shelfUris.length > 0
          ? inArray(sql`${records.value}->>'shelf'`, [...shelfUris])
          : undefined,
        bookUri ? sql`${records.value}->'book'->>'uri' = ${bookUri}` : undefined,
      )
    : undefined;
  const bookhive = wantBookhive
    ? and(
        eq(records.collection, BOOKHIVE_BOOK_COLLECTION),
        // A Bookhive record only shelves a book once a status is set; a bare
        // copy with no status is owned, not shelved, and belongs on no shelf.
        sql`${records.value}->>'status' IS NOT NULL`,
        shelfUris && shelfUris.length > 0
          ? inArray(sql`${records.value}->>'status'`, statuses)
          : undefined,
        bookhiveSubject ? sql`${bookhiveSubjectSql()} = ${bookhiveSubject}` : undefined,
      )
    : undefined;

  const collections = [wantNative ? SHELVING_COLLECTION : null, wantBookhive ? BOOKHIVE_BOOK_COLLECTION : null]
    .filter((collection): collection is string => collection !== null);

  return and(
    inArray(records.collection, collections),
    did ? eq(records.did, did) : undefined,
    or(...[native, bookhive].filter((branch): branch is SQL => branch !== undefined)),
  )!;
}
