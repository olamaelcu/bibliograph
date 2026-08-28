import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { editions } from '../db/schema';
import type { EditionRow } from '../db/schema';
import { googleBooksBreaker, isbndbBreaker } from '../api/breakers';
import { withRetry } from '../api/retry';
import { UPSTREAM_TIMEOUT_MS } from '../api/timeout';
import { isGbRkey, volumeIdFromGbRkey } from '../gb/keys';
import {
  googleBooksDescription,
  type GbVolumeInfo,
} from '../api/google-books';
import {
  getBookByIsbn,
  isbndbDescription,
} from '../api/isbndb';
import { getEditionByRkey, openLibraryDescription } from '../api/open-library';

/**
 * Backfill missing `description` on an edition record.
 *
 * Mirrors `cover-backfill.ts`:
 *   - GB by volume-id (GB rkey) or by ISBN (fallback)
 *   - OL by rkey (edition record already has OL id)
 *   - ISBNdb by ISBN (last resort)
 *
 * Updates the row + recomputes the record CID when the new description
 * changes the stored value. Skipped when a description already exists.
 */

type Db = typeof defaultDb;

const GB_BASE = 'https://www.googleapis.com/books/v1/volumes';

interface GbVolumeShape {
  id?: string;
  volumeInfo?: GbVolumeInfo;
  searchInfo?: { textSnippet?: string };
}

async function fetchGbByVolumeId(
  volumeId: string,
  log: Logger,
  signal: AbortSignal,
): Promise<GbVolumeShape | null> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) return null;
  if (!googleBooksBreaker.canCall()) {
    log.warn({ stage: 'description-backfill', breaker: googleBooksBreaker.getState() }, 'googlebooks breaker open; skipping GB volume fetch');
    return null;
  }
  const url = key
    ? `${GB_BASE}/${encodeURIComponent(volumeId)}?key=${encodeURIComponent(key)}`
    : `${GB_BASE}/${encodeURIComponent(volumeId)}`;
  try {
    const data = await withRetry(
      () =>
        fetch(url, { signal }).then(async (res) => {
          if (!res.ok) {
            const err = new Error(`googlebooks ${res.status}`) as Error & { status: number };
            err.status = res.status;
            throw err;
          }
          return (await res.json()) as GbVolumeShape;
        }),
      log,
    );
    googleBooksBreaker.recordSuccess();
    return data;
  } catch (err) {
    googleBooksBreaker.recordFailure();
    log.warn({ stage: 'description-backfill', err, volumeId }, 'GB volume fetch failed');
    return null;
  }
}

async function fetchGbByIsbn(
  isbn: string,
  log: Logger,
  signal: AbortSignal,
): Promise<GbVolumeShape | null> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) return null;
  if (!googleBooksBreaker.canCall()) {
    log.warn({ stage: 'description-backfill', breaker: googleBooksBreaker.getState() }, 'googlebooks breaker open; skipping GB isbn fetch');
    return null;
  }
  const url = `${GB_BASE}?q=isbn:${encodeURIComponent(isbn)}&key=${encodeURIComponent(key)}`;
  try {
    const data = await withRetry(
      () =>
        fetch(url, { signal }).then(async (res) => {
          if (!res.ok) {
            const err = new Error(`googlebooks ${res.status}`) as Error & { status: number };
            err.status = res.status;
            throw err;
          }
          return (await res.json()) as { items?: GbVolumeShape[] };
        }),
      log,
    );
    googleBooksBreaker.recordSuccess();
    return data.items?.[0] ?? null;
  } catch (err) {
    googleBooksBreaker.recordFailure();
    log.warn({ stage: 'description-backfill', err, isbn }, 'GB isbn fetch failed');
    return null;
  }
}

export async function resolveDescription(
  row: EditionRow,
  log: Logger,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (isGbRkey(row.rkey)) {
    try {
      const vid = volumeIdFromGbRkey(row.rkey);
      const vol = await fetchGbByVolumeId(vid, log, signal);
      const desc = googleBooksDescription(vol?.volumeInfo, vol?.searchInfo?.textSnippet);
      if (desc) return desc;
    } catch {
      // Invalid rkey already validated.
    }
  } else {
    // OL path: edition doc already has the description field.
    const olItem = await getEditionByRkey(row.rkey, log, signal);
    const desc = openLibraryDescription(olItem?.description);
    if (desc) return desc;
  }

  const isbn = isbnFromIdentifiers(row.identifiers);
  if (!isbn) return undefined;

  if (googleBooksBreaker.canCall()) {
    const vol = await fetchGbByIsbn(isbn, log, signal);
    const desc = googleBooksDescription(vol?.volumeInfo, vol?.searchInfo?.textSnippet);
    if (desc) return desc;
  }

  if (isbndbBreaker.canCall()) {
    const book = await getBookByIsbn(isbn, log, signal);
    const desc = book ? isbndbDescription(book) : undefined;
    if (desc) return desc;
  }

  return undefined;
}

export function isbnFromIdentifiers(
  identifiers: ReadonlyArray<{ uri: string; resource: string }>,
): string | undefined {
  for (const ident of identifiers) {
    if (ident.resource === 'isbn13' || ident.resource === 'isbn10' || ident.resource === 'isbn') {
      return ident.uri.replace(/^isbn:/, '');
    }
  }
  return undefined;
}

function editionValueForCid(row: EditionRow, description: string): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.edition' as const,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    place: row.place ?? undefined,
    publishedYear: row.publishedYear ?? undefined,
    language: row.language ?? undefined,
    coverImageUrl: row.coverImageUrl ?? undefined,
    contributors: row.contributors,
    identifiers: row.identifiers,
    description,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function backfillDescriptionForEdition(
  uri: string,
  log: Logger,
  db: Db = defaultDb,
  signal: AbortSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
): Promise<{ updated: boolean; description?: string; reason: string }> {
  const rows = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
  const row = rows[0];
  if (!row) return { updated: false, reason: 'not_found' };
  if (row.description) return { updated: false, reason: 'already_has_description' };

  const description = await resolveDescription(row, log, signal);
  if (!description) return { updated: false, reason: 'no_description_found' };

  const value = editionValueForCid(row, description);
  const cid = (await cidForLex(value as unknown as LexMap)).toString();

  const updated = await db
    .update(editions)
    .set({ description, cid, indexedAt: new Date() })
    .where(eq(editions.uri, uri))
    .returning({ uri: editions.uri });

  if (updated.length === 0) return { updated: false, reason: 'update_missed' };

  log.info({ stage: 'description-backfill', uri, length: description.length, cid }, 'description backfilled');

  return { updated: true, description, reason: 'ok' };
}