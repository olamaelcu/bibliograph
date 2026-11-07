import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { editions } from '../db/schema';
import type { EditionRow } from '../db/schema';
import { googleBooksBreaker } from '../api/breakers';
import { withRetry } from '../api/retry';
import { UPSTREAM_TIMEOUT_MS } from '../api/timeout';
import { isGbRkey, volumeIdFromGbRkey } from '../gb/keys';
import { datacenterCoverUrl } from '../gb/cover-url';
import { getBookByIsbn } from '../api/isbndb';
import { editionRecordValue, rowIdentifiers } from '../edition-record';
import { isbnFromIdentifiers } from '../isbn/lookup';
import { wireContributorsFor } from './wire-contributors';

type Db = typeof defaultDb;

const GB_BASE = 'https://www.googleapis.com/books/v1/volumes';

function gbCoverFromLinks(links: Record<string, string> | undefined): string | undefined {
  if (!links) return undefined;
  const large = links.large ?? links.medium ?? links.thumbnail ?? links.smallThumbnail ?? links.small;
  return large ? datacenterCoverUrl(large.replace(/^http:/, 'https:')) : undefined;
}

async function fetchGbByIsbn(isbn: string, log: Logger, signal: AbortSignal): Promise<string | undefined> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) return undefined;
  if (!googleBooksBreaker.canCall()) {
    log.warn({ stage: 'cover-backfill', breaker: googleBooksBreaker.getState() }, 'googlebooks breaker open; skipping GB fallback');
    return undefined;
  }
  const url = `${GB_BASE}?q=isbn:${encodeURIComponent(isbn)}&key=${encodeURIComponent(key)}`;
  try {
    const data = await withRetry(async () => {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        let body = '';
        try { body = (await res.json()).error?.message ?? await res.text(); } catch { /* ignore */ }
        const err = new Error(`googlebooks ${res.status}: ${body.slice(0, 200)}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as { items?: Array<{ volumeInfo?: { imageLinks?: Record<string, string> } }> };
    }, log);
    googleBooksBreaker.recordSuccess();
    return gbCoverFromLinks(data.items?.[0]?.volumeInfo?.imageLinks);
  } catch (err) {
    googleBooksBreaker.recordFailure();
    log.warn({ stage: 'cover-backfill', err, isbn }, 'GB isbn fetch failed');
    return undefined;
  }
}

async function fetchGbByVolumeId(volumeId: string, log: Logger, signal: AbortSignal): Promise<string | undefined> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) return undefined;
  if (!googleBooksBreaker.canCall()) {
    log.warn({ stage: 'cover-backfill', breaker: googleBooksBreaker.getState() }, 'googlebooks breaker open; skipping GB volume fetch');
    return undefined;
  }
  const url = key ? `${GB_BASE}/${encodeURIComponent(volumeId)}?key=${encodeURIComponent(key)}` : `${GB_BASE}/${encodeURIComponent(volumeId)}`;
  try {
    const data = await withRetry(async () => {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        let body = '';
        try { body = (await res.json()).error?.message ?? await res.text(); } catch { /* ignore */ }
        const err = new Error(`googlebooks ${res.status}: ${body.slice(0, 200)}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as { volumeInfo?: { imageLinks?: Record<string, string> } };
    }, log);
    googleBooksBreaker.recordSuccess();
    return gbCoverFromLinks(data.volumeInfo?.imageLinks);
  } catch (err) {
    googleBooksBreaker.recordFailure();
    log.warn({ stage: 'cover-backfill', err, volumeId }, 'GB volume fetch failed');
    return undefined;
  }
}

export async function resolveCoverUrl(
  row: EditionRow,
  log: Logger,
  signal: AbortSignal,
): Promise<string | undefined> {
  const rkey = row.rkey;

  if (isGbRkey(rkey)) {
    try {
      const vid = volumeIdFromGbRkey(rkey);
      const cover = await fetchGbByVolumeId(vid, log, signal);
      if (cover) return cover;
    } catch { /* invalid rkey already validated */ }
    const isbn = isbnFromIdentifiers(rowIdentifiers(row.identifiers));
    if (isbn) {
      const cover = await fetchGbByIsbn(isbn, log, signal);
      if (cover) return cover;
    }
    return undefined;
  }

  const isbn = isbnFromIdentifiers(rowIdentifiers(row.identifiers));
  if (isbn) {
    const cover = await fetchGbByIsbn(isbn, log, signal);
    if (cover) return cover;
    const isbndbBook = await getBookByIsbn(isbn, log, signal);
    if (isbndbBook?.image) {
      const cover = isbndbBook.image.replace(/^http:/, 'https:');
      if (cover) return cover;
    }
  }

  return undefined;
}

export async function backfillCoverForEdition(
  uri: string,
  rkey: string,
  log: Logger,
  db: Db = defaultDb,
  signal: AbortSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
): Promise<{ updated: boolean; coverUrl?: string; reason: string }> {
  const rows = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
  const row = rows[0];
  if (!row) return { updated: false, reason: 'not_found' };
  if (row.coverImageUrl) return { updated: false, reason: 'already_has_cover' };
  // Validate rkey matches row
  if (row.rkey !== rkey) {
    log.warn({ stage: 'cover-backfill', uri, rkey, rowRkey: row.rkey }, 'rkey mismatch; using row rkey');
  }

  const coverUrl = await resolveCoverUrl(row, log, signal);
  if (!coverUrl) {
    // Stamp the miss: providers answered, there is simply no cover. Without
    // this the scheduled scan re-asks the same rows every tick.
    await db.update(editions).set({ coverCheckedAt: new Date() }).where(eq(editions.uri, uri));
    return { updated: false, reason: 'no_cover_found' };
  }

  const contributors = await wireContributorsFor(db, row.contributors);
  const value = editionRecordValue(row, { contributors, coverUrl });
  if (!value) return { updated: false, reason: 'missing_identifiers' };
  const cid = (await cidForLex(value as unknown as LexMap)).toString();

  const updated = await db.update(editions)
    .set({ coverImageUrl: coverUrl, coverCheckedAt: new Date(), cid, indexedAt: new Date() })
    .where(eq(editions.uri, uri))
    .returning({ uri: editions.uri });

  if (updated.length === 0) return { updated: false, reason: 'update_missed' };

  log.info({ stage: 'cover-backfill', uri, coverUrl, cid }, 'cover backfilled');

  return { updated: true, coverUrl, reason: 'ok' };
}
