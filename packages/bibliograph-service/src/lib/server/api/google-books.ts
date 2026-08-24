import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout';
import type { EditionItem } from '../search/types';

const BASE = 'https://www.googleapis.com/books/v1/volumes';

let warnedMissingKey = false;

interface GbVolume { volumeInfo?: { description?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string } }; }
interface GbSearchResponse { totalItems?: number; items?: GbVolume[]; }

function isbnFromIdentifiers(item: EditionItem): string | undefined {
  for (const id of item.identifiers) {
    if (id.resource === 'isbn13' || id.resource === 'isbn10' || id.resource === 'isbn') {
      return id.uri.replace(/^isbn:/, '');
    }
  }
  return undefined;
}

export async function enrichEditions(
  items: readonly EditionItem[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<EditionItem[]> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn({ stage: 'google-books-enricher' }, 'GOOGLE_BOOKS_API_KEY is not set; Google Books enrichment disabled');
    }
    return [...items];
  }

  const CONCURRENCY = 8;
  const out: EditionItem[] = new Array(items.length);
  let matched = 0;
  let missing = 0;

  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

  // Bounded concurrency: at most CONCURRENCY in-flight fetches at any time.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      if (!item) return;
      const isbn = isbnFromIdentifiers(item);
      if (!isbn) {
        out[i] = item;
        missing++;
        continue;
      }
      const url = `${BASE}?q=isbn:${encodeURIComponent(isbn)}&key=${encodeURIComponent(key ?? '')}`;
      let enriched = item;
      try {
        const start = performance.now();
        const res = await fetch(url, { signal });
        const durationMs = Math.round((performance.now() - start) * 100) / 100;
        if (res.ok) {
          const data = (await res.json()) as GbSearchResponse;
          const info = data.items?.[0]?.volumeInfo;
          if (info) {
            if (!enriched.description && info.description) enriched = { ...enriched, description: info.description };
            const cover = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail;
            if (!enriched.coverImageUrl && cover) enriched = { ...enriched, coverImageUrl: cover };
            matched++;
          } else {
            missing++;
          }
          log.info({ stage: 'google-books-enricher', isbn, matched, missing, durationMs }, 'googlebooks ok');
        } else {
          log.warn({ stage: 'google-books-enricher', status: res.status }, 'googlebooks non-2xx');
          missing++;
        }
      } catch (err) {
        log.error({ stage: 'google-books-enricher', err, isbn }, 'googlebooks fetch failed');
        missing++;
      }
      out[i] = enriched;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()));
  return out;
}
