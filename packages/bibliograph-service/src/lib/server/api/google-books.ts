import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout';
import { withRetry } from './retry';
import { googleBooksBreaker } from './breakers';
import type { EditionItem, WorkItem, SearchQuery, SearchResult, Identifier } from '../search/types';
import { gbEditionUri, gbWorkUri } from '../gb/keys';

const BASE = 'https://www.googleapis.com/books/v1/volumes';

let warnedMissingKey = false;

interface GbImageLinks { thumbnail?: string; smallThumbnail?: string; small?: string; medium?: string; large?: string; extraLarge?: string }
interface GbVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  industryIdentifiers?: { type?: string; identifier?: string }[];
  categories?: string[];
  language?: string;
  imageLinks?: GbImageLinks;
  infoLink?: string;
  canonicalVolumeLink?: string;
}
interface GbVolume {
  id?: string;
  volumeInfo?: GbVolumeInfo;
  searchInfo?: { textSnippet?: string };
}
interface GbSearchResponse { totalItems?: number; items?: GbVolume[]; }

function isbnFromIdentifiers(item: EditionItem): string | undefined {
  for (const id of item.identifiers) {
    if (id.resource === 'isbn13' || id.resource === 'isbn10' || id.resource === 'isbn') {
      return id.uri.replace(/^isbn:/, '');
    }
  }
  return undefined;
}

function makeGbVolumeIdentifier(volumeId: string): Identifier {
  return { uri: `https://books.google.com/books?id=${volumeId}`, resource: 'googlebooks' };
}

function gbIsbnIdentifier(type: string | undefined, raw: string): Identifier | null {
  const clean = raw.replace(/-/g, '');
  if (!clean) return null;
  const resource = type === 'ISBN_13' || clean.length === 13 ? 'isbn13'
    : type === 'ISBN_10' || clean.length === 10 ? 'isbn10'
    : 'isbn';
  return { uri: `isbn:${clean}`, resource };
}

function yearFromGbPublishedDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})/.exec(s);
  return m ? Number(m[1]) : undefined;
}

function coverFromLinks(il: GbImageLinks | undefined): string | undefined {
  const link = il?.large ?? il?.medium ?? il?.thumbnail ?? il?.smallThumbnail ?? il?.small;
  return link ? link.replace(/^http:/, 'https:') : undefined;
}

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim() || undefined;
}

function descriptionFromGb(info: GbVolumeInfo | undefined, fallback: string | undefined): string | undefined {
  return stripHtml(info?.description ?? fallback);
}

export function mapGbToEdition(v: GbVolume, createdAt: string): EditionItem | null {
  const info = v.volumeInfo;
  if (!info?.title || !v.id) return null;
  const ids: Identifier[] = [makeGbVolumeIdentifier(v.id)];
  for (const ii of info.industryIdentifiers ?? []) {
    if (!ii.type || !ii.identifier) continue;
    const ident = gbIsbnIdentifier(ii.type, ii.identifier);
    if (ident) ids.push(ident);
    if (ids.length >= 6) break;
  }
  if (info.canonicalVolumeLink) ids.push({ uri: info.canonicalVolumeLink, resource: 'googlebooks-canonical' });
  return {
    uri: gbEditionUri(v.id),
    title: info.title,
    subtitle: info.subtitle,
    publishedYear: yearFromGbPublishedDate(info.publishedDate),
    language: info.language,
    description: descriptionFromGb(info, v.searchInfo?.textSnippet),
    coverImageUrl: coverFromLinks(info.imageLinks),
    identifiers: ids,
    contributors: [],
    createdAt,
  };
}

export function mapGbToWork(v: GbVolume, createdAt: string): WorkItem | null {
  const info = v.volumeInfo;
  if (!info?.title || !v.id) return null;
  const ids: Identifier[] = [makeGbVolumeIdentifier(v.id)];
  for (const ii of info.industryIdentifiers ?? []) {
    if (!ii.type || !ii.identifier) continue;
    const ident = gbIsbnIdentifier(ii.type, ii.identifier);
    if (ident) ids.push(ident);
  }
  const subjects = (info.categories ?? [])
    .flatMap((c) => c.split('/').map((s) => s.trim()).filter(Boolean));
  return {
    uri: gbWorkUri(v.id),
    title: info.title,
    subtitle: info.subtitle,
    originalLanguage: info.language,
    firstPublishedYear: yearFromGbPublishedDate(info.publishedDate),
    subjects,
    description: descriptionFromGb(info, v.searchInfo?.textSnippet),
    contributors: [],
    identifiers: ids,
    createdAt,
  };
}

function buildGbUrl(q: string, limit: number, startIndex: number, key: string): string {
  const u = new URL(BASE);
  u.searchParams.set('q', q);
  u.searchParams.set('maxResults', String(limit));
  u.searchParams.set('startIndex', String(startIndex));
  u.searchParams.set('printType', 'books');
  if (key) u.searchParams.set('key', key);
  return u.toString();
}

type GbCursor = { v: 1; src: 'googlebooks'; s: number };

function encodeGbCursor(s: number): string {
  const payload: GbCursor = { v: 1, src: 'googlebooks', s };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeGbCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (parsed.v === 1 && parsed.src === 'googlebooks' && typeof parsed.s === 'number') return parsed.s;
  } catch { /* ignore */ }
  return 0;
}

async function gbFetch<T>(url: string, log: Logger, signal: AbortSignal): Promise<T | null> {
  if (!googleBooksBreaker.canCall()) {
    log.warn({ stage: 'google-books-source', breaker: googleBooksBreaker.getState() }, 'breaker open; skipping fetch');
    return null;
  }
  try {
    const body = await withRetry(async () => {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        let body = '';
        try { body = (await res.json()).error?.message ?? await res.text(); } catch { /* ignore */ }
        const err = new Error(`googlebooks ${res.status}: ${body.slice(0, 200)}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    }, log);
    googleBooksBreaker.recordSuccess();
    return body;
  } catch (err) {
    googleBooksBreaker.recordFailure();
    log.error({ stage: 'google-books-source', err, url }, 'googlebooks fetch failed');
    return null;
  }
}

export async function searchEditions(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<EditionItem>> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn({ stage: 'google-books-source' }, 'GOOGLE_BOOKS_API_KEY is not set; Google Books search disabled');
    }
    return { items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'missing_api_key' } };
  }
  if (!query.q) {
    return { items: [], total: 0 };
  }
  const limit = Math.min(query.limit, 40);
  const startIndex = decodeGbCursor(query.cursor);
  const url = buildGbUrl(query.q, limit, startIndex, key);
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await gbFetch<GbSearchResponse>(url, log, signal);
  if (!data) {
    return { items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } };
  }
  const createdAt = new Date().toISOString();
  const items: EditionItem[] = [];
  for (const v of data.items ?? []) {
    const mapped = mapGbToEdition(v, createdAt);
    if (mapped) items.push(mapped);
  }
  const fetchedCount = data.items?.length ?? 0;
  const nextStart = startIndex + fetchedCount;
  const cursor = data.totalItems !== undefined && nextStart < data.totalItems && fetchedCount > 0
    ? encodeGbCursor(nextStart)
    : undefined;
  log.info({ stage: 'google-books-source', q: query.q, items: items.length, total: data.totalItems, cursor: !!cursor }, 'googlebooks ok');
  return { items, total: data.totalItems ?? 0, cursor };
}

export async function searchWorks(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<WorkItem>> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn({ stage: 'google-books-source' }, 'GOOGLE_BOOKS_API_KEY is not set; Google Books search disabled');
    }
    return { items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'missing_api_key' } };
  }
  if (!query.q) {
    return { items: [], total: 0 };
  }
  const limit = Math.min(query.limit, 40);
  const startIndex = decodeGbCursor(query.cursor);
  const url = buildGbUrl(query.q, limit, startIndex, key);
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await gbFetch<GbSearchResponse>(url, log, signal);
  if (!data) {
    return { items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } };
  }
  const createdAt = new Date().toISOString();
  const items: WorkItem[] = [];
  for (const v of data.items ?? []) {
    const mapped = mapGbToWork(v, createdAt);
    if (mapped) items.push(mapped);
  }
  const fetchedCount = data.items?.length ?? 0;
  const nextStart = startIndex + fetchedCount;
  const cursor = data.totalItems !== undefined && nextStart < data.totalItems && fetchedCount > 0
    ? encodeGbCursor(nextStart)
    : undefined;
  log.info({ stage: 'google-books-source', q: query.q, items: items.length, total: data.totalItems, cursor: !!cursor }, 'googlebooks ok');
  return { items, total: data.totalItems ?? 0, cursor };
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
            if (!enriched.description && info.description) enriched = { ...enriched, description: stripHtml(info.description) };
            const cover = coverFromLinks(info.imageLinks);
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