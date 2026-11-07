import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { editions, records } from '../db/schema';
import { resolveEditions } from '../edition-lookup';
import { recordSortKeyOf } from '../db/record-recency';
import type { RecordRow } from '../db/schema';
import { pdsClient } from '../pds/resolve';
import { NetOlamaelcuLivtetBiblioDefs } from '../lexicons/index.js';
import { createLogger } from '../logger';
import { BOOKHIVE_BOOK_COLLECTION } from '../bookhive/keys';
import { normalizeBookhiveBook } from '../bookhive/records';
import { catalogEditionUriFromRkey } from './catalog-uri';
import { formatViewFor } from '../format-view';
import { usableCoverUrl } from '../book-wire';
import { loadContributorRefs } from '../contributor-refs';
import { displayNameForShelfRkey, shelfViewFromValue } from './shelf-view';

const log = createLogger('web');

type Did = `did:${string}:${string}`;

// The derivation moved to `catalog-uri.ts` so job handlers can use it without
// pulling in this module's `db` import. Re-exported here for existing callers.
export { catalogEditionUriFromRkey };

// The display-name table and the record→view derivation moved to
// `shelf-view.ts`, so the mirror read here, the PDS read in `getShelf` and the
// shelf listing all publish the same view. Re-exported for existing callers.
export { displayNameForShelfRkey } from './shelf-view';

export async function hydrateShelvesByUri(
  uris: string[],
): Promise<Map<string, NetOlamaelcuLivtetBiblioDefs.ShelfView>> {
  if (uris.length === 0) return new Map();
  const rows = await db.select().from(records).where(inArray(records.uri, uris));
  const map = new Map<string, NetOlamaelcuLivtetBiblioDefs.ShelfView>();
  for (const r of rows) {
    map.set(r.uri, shelfViewFromValue(r.uri, r.value));
  }
  return map;
}

export async function hydrateBookByUri(
  uri: string,
): Promise<NetOlamaelcuLivtetBiblioDefs.BookView | null> {
  // `resolveEditions` folds a uri retired by a merge onto the book that absorbed
  // it, so a shelving row written before the merge still hydrates.
  const row = (await resolveEditions([uri])).get(uri);
  if (!row) return null;
  return makeBookView(row, await contributorNamesFor([row]));
}

/** The names a book view inlines; rows only store contributor strongRefs. */
async function contributorNamesFor(
  rows: ReadonlyArray<typeof editions.$inferSelect>,
): Promise<Map<string, string>> {
  const uris = new Set<string>();
  for (const row of rows) {
    for (const entry of row.contributors ?? []) uris.add(entry.subject.uri);
  }
  const refs = await loadContributorRefs([...uris]);
  return new Map([...refs].map(([uri, ref]) => [uri, ref.name]));
}

export async function hydrateBooksByUri(
  uris: string[],
): Promise<Map<string, NetOlamaelcuLivtetBiblioDefs.BookView>> {
  const map = new Map<string, NetOlamaelcuLivtetBiblioDefs.BookView>();
  if (uris.length === 0) return map;
  // Keyed by every requested uri *and* the canonical uri of the row it resolved
  // to, so two uris naming the same book answer with one book view.
  const views = new Map<string, NetOlamaelcuLivtetBiblioDefs.BookView>();
  const byUri = await resolveEditions(uris);
  const names = await contributorNamesFor(
    [...new Map([...byUri.values()].map((row) => [row.uri, row])).values()],
  );
  for (const [uri, row] of byUri) {
    let view = views.get(row.tid);
    if (!view) {
      view = makeBookView(row, names);
      views.set(row.tid, view);
    }
    map.set(uri, view);
  }
  return map;
}

function makeBookView(
  row: typeof editions.$inferSelect,
  contributorNames: Map<string, string>,
): NetOlamaelcuLivtetBiblioDefs.BookView {
  return {
    uri: row.uri as never,
    title: row.title,
    // A provider's "no cover" placeholder is not artwork; omit the field.
    coverUrl: usableCoverUrl(row.coverImageUrl) as never,
    publishDate: row.publishedYear ? `${row.publishedYear}` : undefined,
    format: formatViewFor(row.format) as never,
    pages: row.pages ?? undefined,
    contributors: (row.contributors ?? [])
      .map((c) => ({ entry: c, name: contributorNames.get(c.subject.uri)?.trim() ?? '' }))
      // `defs#contributorView.name` is required and non-empty; a ref whose row
      // is gone would otherwise publish an invalid contributor.
      .filter(({ name }) => name !== '')
      .map(({ entry, name }) => ({
        bookUri: row.uri as never,
        contributor: {
          name,
          uri: entry.subject.uri as never,
          $type: 'net.olamaelcu.livtet.biblio.defs#contributorView' as const,
        },
        role: entry.role as never,
        $type: 'net.olamaelcu.livtet.biblio.defs#bookContributorView' as const,
      })),
    $type: 'net.olamaelcu.livtet.biblio.defs#bookView',
  };
}

export function buildBookShelfView(
  row: RecordRow,
  shelfView: NetOlamaelcuLivtetBiblioDefs.ShelfView,
  bookView: NetOlamaelcuLivtetBiblioDefs.BookView,
): NetOlamaelcuLivtetBiblioDefs.BookShelfView {
  const v = row.value as { metadata?: Record<string, unknown>; createdAt?: string; updatedAt?: string };
  return {
    uri: row.uri as never,
    shelf: shelfView,
    book: bookView,
    metadata: (v.metadata ?? {}) as NetOlamaelcuLivtetBiblioDefs.BookShelfMetadata,
    did: row.did as Did,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    $type: 'net.olamaelcu.livtet.biblio.defs#bookShelfView',
  };
}

export interface ResolvedBookShelf {
  ok: boolean;
  view?: NetOlamaelcuLivtetBiblioDefs.BookShelfView;
  reason?: 'book-not-found' | 'shelf-not-found';
}

/**
 * Catalog URI a shelving row points at: the record's own `book.uri`, or the
 * edition URI derived from its rkey when the record predates the field. Single
 * definition so `resolveBookShelf`, the hydration pass and the shelf backfill
 * script can never disagree about which edition a row needs.
 */
export function bookUriForRow(row: RecordRow): string | null {
  // A Bookhive record names no edition: its book is the `bh.` edition its
  // catalog record (`hiveBookUri`, or `hiveId` alone) maps to. Without this
  // branch those rows fall through to the rkey derivation below, which cannot
  // read a TID — the edition never reaches the batch, and every Bookhive row
  // is dropped as book-not-found.
  if (row.collection === BOOKHIVE_BOOK_COLLECTION) {
    return normalizeBookhiveBook(row.value).editionUri;
  }
  const value = row.value;
  if (value && typeof value === 'object' && 'book' in value) {
    const book = value.book;
    if (book && typeof book === 'object' && 'uri' in book) {
      const uri = book.uri;
      if (typeof uri === 'string' && uri) return uri;
    }
  }
  return catalogEditionUriFromRkey(row.rkey);
}

/** Shelf URI a shelving row points at, or null when the record omits it. */
export function shelfUriForRow(row: RecordRow): string | null {
  const value = row.value;
  if (!value || typeof value !== 'object' || !('shelf' in value)) return null;
  const shelf = value.shelf;
  return typeof shelf === 'string' && shelf ? shelf : null;
}

export function resolveBookShelf(
  row: RecordRow,
  bookMap: Map<string, NetOlamaelcuLivtetBiblioDefs.BookView>,
  shelfMap: Map<string, NetOlamaelcuLivtetBiblioDefs.ShelfView>,
): ResolvedBookShelf {
  // Bookhive has no shelf records: the reading status is inline on the user's
  // book record, so the shelving view is derived rather than hydrated.
  if (row.collection === BOOKHIVE_BOOK_COLLECTION) {
    return resolveBookhiveShelf(row, bookMap);
  }
  const resolvedBookUri = bookUriForRow(row);
  const bookView = resolvedBookUri ? bookMap.get(resolvedBookUri) : undefined;
  if (!bookView) {
    return { ok: false, reason: 'book-not-found' };
  }

  const shelfUri = shelfUriForRow(row);
  const cachedShelf = shelfUri ? shelfMap.get(shelfUri) : undefined;
  const shelfRkey = shelfUri ? shelfUri.split('/').pop() ?? '' : '';
  const displayName = cachedShelf && cachedShelf.name ? cachedShelf.name : displayNameForShelfRkey(shelfRkey);
  const shelfView: NetOlamaelcuLivtetBiblioDefs.ShelfView = shelfUri
    ? {
        uri: shelfUri as never,
        name: displayName ?? (cachedShelf?.name ?? ''),
        $type: 'net.olamaelcu.livtet.biblio.defs#shelfView' as const,
      }
    : { uri: '' as never, name: '', $type: 'net.olamaelcu.livtet.biblio.defs#shelfView' as const };

  return { ok: true, view: buildBookShelfView(row, shelfView, bookView) };
}

/**
 * Shelving view for a `buzz.bookhive.book` record.
 *
 * Bookhive keeps the reading status inline (there is no shelf record), so the
 * shelf view carries the display name only and the status travels in
 * `metadata.status` — that is the field clients should read. The record uri is
 * the user's own book record, which is what actually places the book on their
 * shelf, so it is used as the view uri.
 *
 * A record whose catalog book ingestion has not mirrored yet still resolves:
 * the book view is synthesized from the record's own title and author instead
 * of dropping the row as `book-not-found`.
 *
 * A record with no status is owned, not shelved (the same rule
 * `shelfEntryConditions` applies), and `bookShelfMetadata` requires a status, so
 * such a record has no shelving view to answer with.
 */
function resolveBookhiveShelf(
  row: RecordRow,
  bookMap: Map<string, NetOlamaelcuLivtetBiblioDefs.BookView>,
): ResolvedBookShelf {
  const normalized = normalizeBookhiveBook(row.value);
  const shelf = normalized.shelf;
  if (!shelf) return { ok: false, reason: 'shelf-not-found' };
  const hydrated = normalized.editionUri ? bookMap.get(normalized.editionUri) : undefined;
  let bookView: NetOlamaelcuLivtetBiblioDefs.BookView;
  if (hydrated) {
    bookView = hydrated;
    if (!hydrated.authorNames?.length && normalized.authors) {
      bookView = { ...hydrated, authorNames: [normalized.authors] };
    }
  } else {
    // The record carries its own title and author, so the shelf renders while
    // ingestion has yet to mirror the catalog record into an edition row.
    // Dropping the row instead would hide the book for the whole ingest lag.
    bookView = {
      uri: (normalized.editionUri ?? normalized.subjectUri ?? row.uri) as never,
      title: normalized.title ?? 'Untitled',
      ...(normalized.authors ? { authorNames: [normalized.authors] } : {}),
      $type: 'net.olamaelcu.livtet.biblio.defs#bookView' as const,
    };
  }
  const raw = row.value;
  const createdAt = raw && typeof raw === 'object' && 'createdAt' in raw && typeof raw.createdAt === 'string'
    ? raw.createdAt
    : undefined;
  const shelfView: NetOlamaelcuLivtetBiblioDefs.ShelfView = {
    uri: '' as never,
    name: shelf.name,
    $type: 'net.olamaelcu.livtet.biblio.defs#shelfView' as const,
  };
  const metadata: NetOlamaelcuLivtetBiblioDefs.BookShelfMetadata = {
    status: shelf.status,
    ...(normalized.startedAt ? { startedAt: normalized.startedAt } : {}),
    ...(normalized.finishedAt ? { finishedAt: normalized.finishedAt } : {}),
  };
  return {
    ok: true,
    view: {
      uri: row.uri as never,
      shelf: shelfView,
      book: bookView,
      metadata,
      did: row.did as Did,
      createdAt,
      $type: 'net.olamaelcu.livtet.biblio.defs#bookShelfView',
    },
  };
}

async function fetchPdsRecord(
  uri: string,
  did: string,
  collection: `${string}.${string}.${string}`,
  signal: AbortSignal,
): Promise<RecordRow | null> {
  const [cached] = await db.select().from(records).where(eq(records.uri, uri)).limit(1);
  if (cached) return cached;
  try {
    const { client } = await pdsClient(did, { signal });
    const raw = await client.get('com.atproto.repo.getRecord', {
      params: {
        repo: did as Did,
        collection,
        rkey: uri.split('/').pop()!,
      },
      signal,
    });
    if (!raw || typeof raw !== 'object') return null;
    const wrapper = raw as { ok?: boolean; data?: { uri?: string; cid?: string; value?: Record<string, unknown> } };
    const r = (wrapper.ok === true && wrapper.data ? wrapper.data : raw) as { uri?: string; cid?: string; value?: Record<string, unknown> };
    if (typeof r.uri !== 'string' || !r.value) return null;
    return {
      uri: r.uri,
      cid: r.cid ?? 'bafyplaceholder',
      did,
      rkey: r.uri.split('/').pop() ?? '',
      collection,
      value: r.value as never,
      recordCreatedAt: recordSortKeyOf({ value: r.value }),
      createdAt: new Date(),
      indexedAt: new Date(),
    };
  } catch (err) {
    log.error({ stage: 'shelving.fetchPdsRecord', uri, did, collection, err: err instanceof Error ? err.message : String(err) }, 'PDS read failed');
    return null;
  }
}

export function fetchBookShelvingRecord(
  uri: string,
  did: string,
  signal: AbortSignal,
): Promise<RecordRow | null> {
  return fetchPdsRecord(uri, did, 'net.olamaelcu.livtet.biblio.bookShelving', signal);
}

/** Read a Bookhive user's book record (review + reading status) from its PDS. */
export function fetchBookhiveBookRecord(
  uri: string,
  did: string,
  signal: AbortSignal,
): Promise<RecordRow | null> {
  return fetchPdsRecord(uri, did, BOOKHIVE_BOOK_COLLECTION, signal);
}
