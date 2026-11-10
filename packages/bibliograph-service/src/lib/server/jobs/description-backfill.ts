import type { Logger } from 'pino';
import { eq, isNull, and } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { editions } from '../db/schema';
import type { EditionRow } from '../db/schema';
import { googleBooksBreaker, isbndbBreaker } from '../api/breakers';
import { withRetry } from '../api/retry';
import { isGbRkey, volumeIdFromGbRkey } from '../gb/keys';
import {
  googleBooksDescription,
  type GbVolumeInfo,
} from '../api/google-books';
import {
  getBookByIsbn,
  isbndbDescription,
} from '../api/isbndb';
import { editionRecordValue, rowIdentifiers } from '../edition-record';
import { isbnFromIdentifiers } from '../isbn/lookup';
import { wireContributorsFor } from './wire-contributors';

/**
 * Backfill missing `description` on an edition record.
 *
 * Mirrors `cover-backfill.ts`:
 *   - GB by volume-id (GB rkey) or by ISBN (fallback)
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
  signal?: AbortSignal,
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
  signal?: AbortSignal,
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
  signal?: AbortSignal,
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
  }

  const isbn = isbnFromIdentifiers(rowIdentifiers(row.identifiers));
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

/**
 * A negative is only trustworthy when nothing was asked, or everything asked
 * answered. Any recorded upstream failure means the row may still have a
 * description, so the stamp has to wait for a later run.
 */
export function canStampPermanentMiss(
  failuresBefore: number,
  failuresAfter: number,
  breakerOpenBefore: boolean,
): boolean {
  return !breakerOpenBefore && failuresAfter === failuresBefore;
}

export async function backfillDescriptionForEdition(
  uri: string,
  log: Logger,
  db: Db = defaultDb,
  signal?: AbortSignal,
): Promise<{ updated: boolean; description?: string; reason: string }> {
  const rows = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
  const row = rows[0];
  if (!row) return { updated: false, reason: 'not_found' };
  if (row.description) return { updated: false, reason: 'already_has_description' };

  // A negative result is only trustworthy when every upstream we would consult
  // was actually reachable; otherwise the row stays unchecked for a later run.
  // An open breaker only tells us the upstream *was* failing, so the call-time
  // failure count is what decides: a 429 recorded mid-call is invisible to
  // `canCall()` alone.
  const breakerOpenBefore = [googleBooksBreaker, isbndbBreaker].some((b) => !b.canCall());
  const failuresBefore =
    googleBooksBreaker.getTotalFailures() + isbndbBreaker.getTotalFailures();
  const description = await resolveDescription(row, log, signal);
  if (!description) {
    const failuresAfter =
      googleBooksBreaker.getTotalFailures() + isbndbBreaker.getTotalFailures();
    if (!canStampPermanentMiss(failuresBefore, failuresAfter, breakerOpenBefore)) {
      log.warn({ stage: 'description-backfill', uri }, 'an upstream request failed; leaving description unchecked');
      return { updated: false, reason: 'deferred' };
    }
    await db.update(editions).set({ descriptionCheckedAt: new Date() }).where(eq(editions.uri, uri));
    return { updated: false, reason: 'no_description_found' };
  }

  const contributors = await wireContributorsFor(db, row.contributors);
  const value = editionRecordValue(row, { contributors, description });
  if (!value) return { updated: false, reason: 'missing_identifiers' };
  const cid = (await cidForLex(value as unknown as LexMap)).toString();

  const updated = await db
    .update(editions)
    .set({ description, cid, indexedAt: new Date(), descriptionCheckedAt: new Date() })
    .where(eq(editions.uri, uri))
    .returning({ uri: editions.uri });

  if (updated.length === 0) return { updated: false, reason: 'update_missed' };

  log.info({ stage: 'description-backfill', uri, length: description.length, cid }, 'description backfilled');

  return { updated: true, description, reason: 'ok' };
}
export async function findEditionsMissingDescription(
  db: Db = defaultDb,
  limit = 200,
): Promise<string[]> {
  const rows = await db
    .select({ uri: editions.uri })
    .from(editions)
    .where(and(isNull(editions.description), isNull(editions.descriptionCheckedAt)))
    .limit(limit);
  return rows.map((r) => r.uri);
}
