import type { Logger } from 'pino';
import { withRetry } from './retry';
import { searchProviderRequestsTotal, googleBooksCacheTotal } from '../metrics';
import { googleBooksBreaker } from './breakers';
import { requestJson } from '../http/client';
import type { EditionItem, SearchQuery, SearchResult, Identifier } from '../search/types';
import { toGbLangRestrict } from '../search/language';

import { datacenterCoverUrl } from '../gb/cover-url';
import { gbCacheEntry, gbCacheGet, gbCachePut } from '../gb/cache';
import { prefetchContributors, type ContributorResolver } from './contributor-name-resolver';
import { isbnIdentifier, isbnValueFromIdentifier, providerIdentifier, uniqueIdentifiers } from '../identifiers';

const BASE = 'https://www.googleapis.com/books/v1/volumes';

let warnedMissingKey = false;

interface GbImageLinks { thumbnail?: string; smallThumbnail?: string; small?: string; medium?: string; large?: string; extraLarge?: string }
export interface GbVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
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
    const isbn = isbnValueFromIdentifier(id);
    if (isbn) return isbn;
  }
  return undefined;
}

function makeGbVolumeIdentifier(volumeId: string): Identifier {
  return providerIdentifier('googlebooks', `https://books.google.com/books?id=${volumeId}`);
}

function yearFromGbPublishedDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})/.exec(s);
  return m ? Number(m[1]) : undefined;
}

function coverFromLinks(il: GbImageLinks | undefined): string | undefined {
  const link = il?.large ?? il?.medium ?? il?.thumbnail ?? il?.smallThumbnail ?? il?.small;
  return link ? datacenterCoverUrl(link.replace(/^http:/, 'https:').replace('&edge=curl', '')) : undefined;
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

export function googleBooksDescription(
  info: GbVolumeInfo | undefined,
  fallback: string | undefined,
): string | undefined {
  return descriptionFromGb(info, fallback);
}

export async function mapGbToEdition(v: GbVolume, createdAt: string, resolver: ContributorResolver): Promise<EditionItem | null> {
  const info = v.volumeInfo;
  if (!info?.title || !v.id) return null;
  const ids: Identifier[] = [makeGbVolumeIdentifier(v.id)];
  for (const ii of info.industryIdentifiers ?? []) {
    if (!ii.identifier) continue;
    const ident = isbnIdentifier(ii.identifier);
    if (ident) ids.push(ident);
    if (ids.length >= 6) break;
  }
  if (info.canonicalVolumeLink) {
    ids.push(providerIdentifier('googlebooks-canonical', info.canonicalVolumeLink));
  }
  const contributors = await resolver.resolve(info.authors ?? []);
  return {
    title: info.title,
    subtitle: info.subtitle,
    publishedYear: yearFromGbPublishedDate(info.publishedDate),
    language: info.language,
    description: descriptionFromGb(info, v.searchInfo?.textSnippet),
    coverUrl: coverFromLinks(info.imageLinks),
    publisher: info.publisher ? { name: info.publisher } : null,
    pages: info.pageCount,
    // An ISBN_10 and its ISBN_13 carry the same canonical `isbn` identifier.
    identifiers: uniqueIdentifiers(ids),
    contributors,
    createdAt,
  };
}


function buildGbUrl(q: string, limit: number, startIndex: number, key: string, langRestrict?: string): string {
  const u = new URL(BASE);
  u.searchParams.set('q', q);
  u.searchParams.set('maxResults', String(limit));
  u.searchParams.set('startIndex', String(startIndex));
  u.searchParams.set('printType', 'books');
  if (key) u.searchParams.set('key', key);
  // GB `langRestrict=` accepts a single 2-letter ISO 639-1 tag only — it
  // returns nothing on a multi-tag request. We only set it when the caller
  // passed exactly one BCP-47 tag and it maps cleanly to ISO 639-1.
  // Otherwise we omit the param and let the postgres-side `lang` filter
  // handle the language scope after the merge.
  if (langRestrict) u.searchParams.set('langRestrict', langRestrict);
  return u.toString();
}

/**
 * Pick the single GB `langRestrict` value from a `lang[]` list, if any.
 * Returns undefined if the list is empty, has more than one tag, or doesn't
 * map cleanly to an ISO 639-1 code.
 */
function pickGbLangRestrict(lang?: string[]): string | undefined {
  if (!lang || lang.length !== 1) return undefined;
  return toGbLangRestrict(lang[0]!) ?? undefined;
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

/** The HTTP status carried by the errors thrown inside `gbFetch`, if any. */
function upstreamStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  const { status } = err;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Single choke point for Google Books HTTP.
 *
 * Every caller (search, work search, ISBN enrichment, single-volume hydration)
 * goes through here so that they all share one cache entry per URL, one breaker,
 * and one metric. The cache is consulted before the breaker: a remembered answer
 * costs nothing upstream, so there is no reason to withhold it while the breaker
 * is open.
 */
async function gbFetch<T>(url: string, log: Logger, signal?: AbortSignal): Promise<T | null> {
  const entry = gbCacheEntry(url);
  const cached = await gbCacheGet<T>(entry.key, log);
  if (cached.found) {
    googleBooksCacheTotal.inc({ result: cached.body === null ? 'negative' : 'hit' });
    log.debug({ stage: 'google-books-source', url: entry.url, negative: cached.body === null }, 'googlebooks cache hit');
    return cached.body;
  }
  if (!googleBooksBreaker.canCall()) {
    log.warn({ stage: 'google-books-source', breaker: googleBooksBreaker.getState() }, 'breaker open; skipping fetch');
    return null;
  }
  try {
    // The transport supplies the 3s budget; this path is on every search and
    // shelf hydration, so a hung quota answer must not hold the response.
    const body = await withRetry(() => requestJson<T>(url, { signal }), log);
    googleBooksBreaker.recordSuccess();
    searchProviderRequestsTotal.inc({ provider: 'googlebooks', status: 'success' });
    await gbCachePut(entry, body, log);
    return body;
  } catch (err) {
    googleBooksBreaker.recordFailure();
    // A 404 is an answer, not an outage: the volume does not exist. Remember it
    // so hydration of a delisted edition stops re-asking for a day. Everything
    // else (429, 5xx, timeouts, aborts) is transient and must stay uncached, or
    // one bad minute upstream would be replayed all day.
    if (upstreamStatus(err) === 404) {
      await gbCachePut(entry, null, log);
    }
    log.error({ stage: 'google-books-source', err, url }, 'googlebooks fetch failed');
    searchProviderRequestsTotal.inc({ provider: 'googlebooks', status: 'failure' });
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
  // Google Books pages by `startIndex` alone: a caller that pages with `offset`
  // (the XRPC searchEditions handler does) was served page 1 forever.
  const startIndex = query.cursor ? decodeGbCursor(query.cursor) : Math.min(query.offset ?? 0, 1000);
  const url = buildGbUrl(query.q, limit, startIndex, key, pickGbLangRestrict(query.lang));
  const data = await gbFetch<GbSearchResponse>(url, log, externalSignal);
  if (!data) {
    return { items: [], total: 0, degraded: { upstream: 'googlebooks', reason: 'fetch_failed' } };
  }
  const createdAt = new Date().toISOString();
  // Volumes map independently: no ordering, no shared state. Mapping them
  // concurrently keeps a page from costing one round trip per volume.
  // Every author on the page resolves in one prefetch, so the concurrent map
  // below never queues on the contributor table.
  const resolver = await prefetchContributors(
    (data.items ?? []).flatMap((v) => v.volumeInfo?.authors ?? []),
    'googlebooks',
    log,
  );
  const items = (
    await Promise.all((data.items ?? []).map((v) => mapGbToEdition(v, createdAt, resolver)))
  ).filter((item): item is EditionItem => item !== null);
  const fetchedCount = data.items?.length ?? 0;
  const nextStart = startIndex + fetchedCount;
  const cursor = data.totalItems !== undefined && nextStart < data.totalItems && fetchedCount > 0
    ? encodeGbCursor(nextStart)
    : undefined;
  log.info({ stage: 'google-books-source', q: query.q, items: items.length, total: data.totalItems, cursor: !!cursor }, 'googlebooks ok');
  return { items, total: data.totalItems ?? 0, cursor, hasMore: cursor !== undefined };
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

  const signal = externalSignal;

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
      // Skip-if-complete: the only fields this enricher writes are description,
      // pages and cover. When all three are already present there is nothing to
      // merge, and the lookup would spend quota to prove it — the search paths
      // call this on every result of every distinct query.
      if (item.description && item.coverUrl && item.pages !== undefined) {
        out[i] = item;
        continue;
      }
      const url = `${BASE}?q=isbn:${encodeURIComponent(isbn)}&key=${encodeURIComponent(key ?? '')}`;
      let enriched = item;
      // Through gbFetch, not fetch: the ISBN lookup is the heaviest consumer of
      // the quota (one request per edition, 8 at a time), so this is the path the
      // cache exists for. It also inherits the retry/breaker/metric behavior that
      // every other GB call already has.
      const start = performance.now();
      const data = await gbFetch<GbSearchResponse>(url, log, signal);
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      if (data) {
        const info = data.items?.[0]?.volumeInfo;
        if (info) {
          if (!enriched.description && info.description) enriched = { ...enriched, description: stripHtml(info.description) };
          if (enriched.pages === undefined && info.pageCount) enriched = { ...enriched, pages: info.pageCount };
          const cover = coverFromLinks(info.imageLinks);
          if (!enriched.coverUrl && cover) enriched = { ...enriched, coverUrl: cover };
          if (enriched.coverUrl) {
            enriched.coverUrl = datacenterCoverUrl(enriched.coverUrl.replace("&edge=curl", ""));
          }
          matched++;
        } else {
          missing++;
        }
        log.info({ stage: 'google-books-enricher', isbn, matched, missing, durationMs }, 'googlebooks ok');
      } else {
        // gbFetch already logged the failure; a failed or negative lookup is the
        // same outcome here — nothing to enrich.
        missing++;
      }
      out[i] = enriched;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()));
  return out;
}

/**
 * Fetch one volume by its Google Books id and map it to an edition.
 *
 * Unlike search, this direct `volumes/{id}` lookup is not gated on
 * GOOGLE_BOOKS_API_KEY: the endpoint answers keyless (with a lower quota), so
 * shelf hydration still works on deployments that never configured a key. When
 * the key is present it is sent to raise the quota.
 */
export async function getEditionByVolumeId(
  volumeId: string,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<EditionItem | null> {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  const suffix = key ? `?key=${encodeURIComponent(key)}` : '';
  const url = `${BASE}/${encodeURIComponent(volumeId)}${suffix}`;
  const volume = await gbFetch<GbVolume>(url, log, externalSignal);
  if (!volume) return null;
  const resolver = await prefetchContributors(volume.volumeInfo?.authors ?? [], 'googlebooks', log);
  return mapGbToEdition(volume, new Date().toISOString(), resolver);
}
