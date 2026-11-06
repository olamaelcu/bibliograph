// `shelfItem` is the membership edge of a custom shelf: one record per
// (shelf, book) pair, carrying no reading status. `bookShelving` answers "what
// is this book's status", this answers "which shelves is this book on" — the
// four status shelves are addressed by fixed rkey, custom shelves by a TID.
//
// Everything here is pure: the query predicate, the limit clamp, the record
// shape checks the PDS fallback scan needs, and the view builder. The handler in
// `xrpc-router` only sequences mirror → PDS → hydration, so each rule below can
// be tested without a database or a network.

import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { records } from '../db/schema';
import type { RecordRow } from '../db/schema';
import type { NetOlamaelcuLivtetBiblioDefs } from '../lexicons/index.js';

export const SHELF_ITEM_COLLECTION = 'net.olamaelcu.livtet.biblio.shelfItem';

export const SHELF_ITEM_DEFAULT_LIMIT = 50;
export const SHELF_ITEM_MAX_LIMIT = 100;

/** `limit` as the query will run it: defaulted, integral, and within bounds. */
export function clampShelfItemLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SHELF_ITEM_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), SHELF_ITEM_MAX_LIMIT);
}

export interface ShelfItemQueryOptions {
  /** AT-URI of the shelf whose items to read. */
  shelfUri: string;
  /** Restrict to the shelf owner's repo. */
  did?: string;
}

/**
 * `WHERE` for the mirror query: the shelfItem collection, filtered on the
 * `shelf` at-uri the record names, scoped to one repo when the caller knows it.
 *
 * The filter is `value->>'shelf'` rather than the record's rkey because the
 * rkey is only derived from the shelf URI: a record written by another client
 * with a different key still belongs on the shelf its value names.
 */
export function shelfItemConditions({ shelfUri, did }: ShelfItemQueryOptions): SQL {
  return and(
    eq(records.collection, SHELF_ITEM_COLLECTION),
    sql`${records.value}->>'shelf' = ${shelfUri}`,
    did ? eq(records.did, did) : undefined,
  )!;
}

export interface ShelfItemBookQueryOptions {
  /** AT-URI of the book whose memberships to read. */
  bookUri: string;
  /** Restrict to the shelf owner's repo. */
  did: string;
}

/** `WHERE` for one book's custom-shelf memberships in one reader's repo. */
export function shelfItemBookConditions({
  bookUri,
  did,
}: ShelfItemBookQueryOptions): SQL {
  return and(
    eq(records.collection, SHELF_ITEM_COLLECTION),
    sql`${records.value}->'book'->>'uri' = ${bookUri}`,
    eq(records.did, did),
  )!;
}

/** Shelf URI an item row points at, or null when the record omits it. */
export function shelfUriForItemRow(row: Pick<RecordRow, 'value'>): string | null {
  const value = row.value;
  if (value === null || typeof value !== 'object' || !('shelf' in value)) return null;
  return typeof value.shelf === 'string' && value.shelf !== '' ? value.shelf : null;
}

/**
 * Whether a record value belongs to `shelfUri`. The PDS fallback scans the
 * whole shelfItem collection and cannot filter server-side, so this is the one
 * test that decides what a page contains.
 */
export function isShelfItemOf(value: unknown, shelfUri: string): boolean {
  return shelfUriForItemRow({ value }) === shelfUri;
}

/**
 * The book URI an item row names. `book` is a strongRef (`{ uri, cid }`); a
 * plain string is accepted too, because a record written by another client may
 * carry the URI directly, and rejecting it would silently empty the shelf.
 */
export function bookUriForItemRow(row: Pick<RecordRow, 'value'>): string | null {
  const value = row.value;
  if (value === null || typeof value !== 'object' || !('book' in value)) return null;
  const book = value.book;
  const uri = typeof book === 'string'
    ? book
    : book !== null && typeof book === 'object' && 'uri' in book
      ? book.uri
      : undefined;
  return typeof uri === 'string' && uri !== '' ? uri : null;
}

/**
 * The metadata the record carries, reduced to the fields the view publishes.
 *
 * A field of the wrong type is dropped rather than forwarded: the view is
 * validated against `defs#shelfItemMetadata`, and one bad `position` must not
 * make the whole item unreadable.
 */
export function shelfItemMetadataOf(value: unknown): NetOlamaelcuLivtetBiblioDefs.ShelfItemMetadata {
  if (value === null || typeof value !== 'object' || !('metadata' in value)) return {};
  const metadata = value.metadata;
  if (metadata === null || typeof metadata !== 'object') return {};
  const position = 'position' in metadata && typeof metadata.position === 'number'
    && Number.isInteger(metadata.position) && metadata.position >= 1
    ? metadata.position
    : undefined;
  const notes = 'notes' in metadata && typeof metadata.notes === 'string' && metadata.notes !== ''
    ? metadata.notes
    : undefined;
  const emoji = 'emoji' in metadata && typeof metadata.emoji === 'string' && metadata.emoji !== ''
    ? metadata.emoji
    : undefined;
  return { position, notes, emoji };
}

/**
 * The item view a mirrored (or PDS-read) row describes. `shelf` and `book` are
 * the hydrated views the caller resolved; a row whose book could not be
 * hydrated is dropped by that caller instead of being published half-empty.
 */
export function buildShelfItemView(
  row: RecordRow,
  shelfView: NetOlamaelcuLivtetBiblioDefs.ShelfView,
  bookView: NetOlamaelcuLivtetBiblioDefs.BookView,
): NetOlamaelcuLivtetBiblioDefs.ShelfItemView {
  const value = row.value;
  const createdAt = value !== null && typeof value === 'object' && 'createdAt' in value
    && typeof value.createdAt === 'string' && value.createdAt !== '' ? value.createdAt : undefined;
  const updatedAt = value !== null && typeof value === 'object' && 'updatedAt' in value
    && typeof value.updatedAt === 'string' && value.updatedAt !== '' ? value.updatedAt : undefined;
  return {
    uri: row.uri as NetOlamaelcuLivtetBiblioDefs.ShelfItemView['uri'],
    shelf: shelfView,
    book: bookView,
    metadata: shelfItemMetadataOf(row.value),
    did: row.did as NetOlamaelcuLivtetBiblioDefs.ShelfItemView['did'],
    createdAt,
    updatedAt,
    $type: 'net.olamaelcu.livtet.biblio.defs#shelfItemView',
  };
}
