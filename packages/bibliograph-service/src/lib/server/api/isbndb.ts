import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout';
import { withRetry } from './retry';
import { isbndbBreaker } from './breakers';
import type { EditionItem, WorkItem, Identifier, SearchQuery, SearchResult } from '../search/types';
import { isbndbEditionUri, isbndbWorkUri } from '../isbndb/keys';
import { resolveContributorsByName } from './contributor-name-resolver';

const BASE = 'https://api2.isbndb.com';

let warnedMissingKey = false;

interface IsbndbBook {
  title?: string;
  title_long?: string;
  isbn?: string;
  isbn13?: string;
  isbn10?: string | null;
  authors?: string[] | null;
  publisher?: string | null;
  language?: string | null;
  date_published?: string | null;
  binding?: string | null;
  edition?: string | null;
  pages?: number | null;
  image?: string | null;
  image_original?: string | null;
  msrp?: number | null;
  overview?: string | null;
  excerpt?: string | null;
  synopsis?: string | null;
  subjects?: string[] | null;
}

interface IsbndbSingleResponse { book?: IsbndbBook }
interface IsbndbListResponse { total?: number; data?: IsbndbBook[]; page?: number; page_size?: number }

function isbnFromIdentifiers(item: EditionItem): string | undefined {
  for (const id of item.identifiers) {
    if (id.resource === 'isbn13' || id.resource === 'isbn10' || id.resource === 'isbn') {
      return id.uri.replace(/^isbn:/, '').replace(/-/g, '');
    }
  }
  return undefined;
}

function makeIsbndbIdentifier(isbn13: string): Identifier {
  return { uri: `https://api2.isbndb.com/book/${isbn13}`, resource: 'isbndb' };
}

function isbnIdentifier(isbn: string): Identifier | null {
  const clean = isbn.replace(/-/g, '');
  if (!clean) return null;
  const resource = clean.length === 13 ? 'isbn13' : clean.length === 10 ? 'isbn10' : 'isbn';
  return { uri: `isbn:${clean}`, resource };
}

function yearFromDatePublished(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})/.exec(s);
  return m ? Number(m[1]) : undefined;
}

function coverFromImage(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  return url.replace(/^http:/, 'https:');
}

function descriptionFromIsbndb(b: IsbndbBook): string | undefined {
  return b.synopsis ?? b.overview ?? b.excerpt ?? undefined;
}

export function isbndbDescription(b: IsbndbBook): string | undefined {
  return descriptionFromIsbndb(b);
}

function primaryIsbn(b: IsbndbBook): string | undefined {
  const raw = (b.isbn13 && b.isbn13.length === 13) ? b.isbn13 : (b.isbn && b.isbn.length === 13 ? b.isbn : undefined);
  if (raw) return raw.replace(/-/g, '');
  if (b.isbn10) return b.isbn10.replace(/-/g, '');
  if (b.isbn) return b.isbn.replace(/-/g, '');
  return undefined;
}

function makeIdentifiers(b: IsbndbBook, primary: string): Identifier[] {
  const ids: Identifier[] = [makeIsbndbIdentifier(primary)];
  for (const raw of [b.isbn13, b.isbn10, b.isbn]) {
    if (!raw) continue;
    const id = isbnIdentifier(raw);
    if (id && !ids.some((existing) => existing.uri === id.uri)) ids.push(id);
  }
  return ids;
}

async function mapIsbndbToEdition(b: IsbndbBook, createdAt: string, log: Logger): Promise<EditionItem | null> {
  if (!b.title) return null;
  const primary = primaryIsbn(b);
  if (!primary) return null;
  const contributors = await resolveContributorsByName(b.authors ?? [], 'isbndb', log);
  return {
    uri: isbndbEditionUri(primary),
    title: b.title,
    subtitle: undefined,
    publishedYear: yearFromDatePublished(b.date_published),
    language: b.language ?? undefined,
    description: descriptionFromIsbndb(b),
    coverImageUrl: coverFromImage(b.image),
    identifiers: makeIdentifiers(b, primary),
    contributors,
    createdAt,
  };
}

async function mapIsbndbToWork(b: IsbndbBook, createdAt: string, log: Logger): Promise<WorkItem | null> {
  if (!b.title) return null;
  const primary = primaryIsbn(b);
  if (!primary) return null;
  const subjects = (b.subjects ?? []).filter((s): s is string => typeof s === 'string');
  const contributors = await resolveContributorsByName(b.authors ?? [], 'isbndb', log);
  return {
    uri: isbndbWorkUri(primary),
    title: b.title,
    subtitle: undefined,
    originalLanguage: b.language ?? undefined,
    firstPublishedYear: yearFromDatePublished(b.date_published),
    subjects,
    description: descriptionFromIsbndb(b),
    contributors,
    identifiers: makeIdentifiers(b, primary),
    createdAt,
  };
}

/**
 * Accept loose ISBN inputs from upstream callers — `q` may arrive as
 * `isbn:9781607785927`, `ISBN13:9781607785927`, a raw `9781607785927`,
 * or a hyphenated `978-1-60-778592-7`. Returns the cleaned 10/13-digit
 * string or `null` if the value is not an ISBN.
 */
export function isbnFromQuery(q: string | undefined): string | null {
  if (!q) return null;
  const m = /^\s*isbn\s*(\d{0,2})?\s*:\s*(.+)\s*$/i.exec(q);
  const raw = (m ? m[2]! : q).replace(/-/g, '').trim();
  return /^\d{10}(\d{3})?$/.test(raw) ? raw : null;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const m = /^"(?:rate|daily)";\s*r=(\d+);\s*t=(\d+)/.exec(header);
  if (m && m[2] !== undefined) return Number(m[2]) * 1000;
  const secs = Number(header);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

async function isbndbFetch<T>(url: string, log: Logger, signal: AbortSignal, init?: RequestInit): Promise<T | null> {
  if (!isbndbBreaker.canCall()) {
    log.warn({ stage: 'isbndb-source', breaker: isbndbBreaker.getState() }, 'breaker open; skipping fetch');
    return null;
  }
  const headers = { ...init?.headers, Authorization: process.env.ISBNDB_API_KEY ?? '' };
  try {
    const body = await withRetry(async () => {
      const res = await fetch(url, { ...init, headers, signal });
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch { /* ignore */ }
        const err = new Error(`isbndb ${res.status}: ${body.slice(0, 200)}`) as Error & { status: number; retryAfterMs?: number };
        err.status = res.status;
        const retryAfter = parseRetryAfter(res.headers.get('ratelimit'));
        if (res.status === 429 && retryAfter !== undefined) err.retryAfterMs = retryAfter;
        throw err;
      }
      return (await res.json()) as T;
    }, log, {
      maxAttempts: 3,
      retryOn: (status) => status === 429 || (status >= 500 && status < 600),
    });
    isbndbBreaker.recordSuccess();
    return body;
  } catch (err) {
    isbndbBreaker.recordFailure();
    log.error({ stage: 'isbndb-source', err, url }, 'isbndb fetch failed');
    return null;
  }
}

function missingKeyDegraded(): SearchResult<EditionItem> & SearchResult<WorkItem> {
  return { items: [], total: 0, degraded: { upstream: 'isbndb', reason: 'missing_api_key' } };
}

export async function searchEditions(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<EditionItem>> {
  if (!process.env.ISBNDB_API_KEY) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn({ stage: 'isbndb-source' }, 'ISBNDB_API_KEY is not set; ISBNDb lookup disabled');
    }
    return missingKeyDegraded();
  }
  if (!query.q) return { items: [], total: 0 };
  const isbn = isbnFromQuery(query.q);
  if (!isbn) {
    return { items: [], total: 0, degraded: { upstream: 'isbndb', reason: 'non_isbn_query' } };
  }
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await isbndbFetch<IsbndbSingleResponse>(
    `${BASE}/book/${encodeURIComponent(isbn)}`,
    log,
    signal,
  );
  if (!data || !data.book) {
    return { items: [], total: 0, degraded: { upstream: 'isbndb', reason: 'fetch_failed' } };
  }
  const createdAt = new Date().toISOString();
  const mapped = await mapIsbndbToEdition(data.book, createdAt, log);
  return { items: mapped ? [mapped] : [], total: mapped ? 1 : 0 };
}

export async function searchWorks(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<WorkItem>> {
  if (!process.env.ISBNDB_API_KEY) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn({ stage: 'isbndb-source' }, 'ISBNDB_API_KEY is not set; ISBNDb lookup disabled');
    }
    return missingKeyDegraded();
  }
  if (!query.q) return { items: [], total: 0 };
  const isbn = isbnFromQuery(query.q);
  if (!isbn) {
    return { items: [], total: 0, degraded: { upstream: 'isbndb', reason: 'non_isbn_query' } };
  }
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await isbndbFetch<IsbndbSingleResponse>(
    `${BASE}/book/${encodeURIComponent(isbn)}`,
    log,
    signal,
  );
  if (!data || !data.book) {
    return { items: [], total: 0, degraded: { upstream: 'isbndb', reason: 'fetch_failed' } };
  }
  const createdAt = new Date().toISOString();
  const mapped = await mapIsbndbToWork(data.book, createdAt, log);
  return { items: mapped ? [mapped] : [], total: mapped ? 1 : 0 };
}

async function bulkLookupByIsbn(isbns: string[], log: Logger, signal: AbortSignal): Promise<Map<string, IsbndbBook>> {
  const out = new Map<string, IsbndbBook>();
  if (isbns.length === 0) return out;
  const CHUNK = 100;
  for (let i = 0; i < isbns.length; i += CHUNK) {
    const chunk = isbns.slice(i, i + CHUNK);
    const res = await isbndbFetch<IsbndbListResponse>(
      `${BASE}/books`,
      log,
      signal,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isbns: chunk }) },
    );
    if (!res || !res.data) continue;
    for (const book of res.data) {
      const primary = primaryIsbn(book);
      if (primary) out.set(primary, book);
    }
  }
  return out;
}

async function enrichEditionsInternal(
  items: readonly EditionItem[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<EditionItem[]> {
  if (!process.env.ISBNDB_API_KEY) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn({ stage: 'isbndb-enricher' }, 'ISBNDB_API_KEY is not set; ISBNDb enrichment disabled');
    }
    return [...items];
  }
  const isbns: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const isbn = isbnFromIdentifiers(item);
    if (isbn && !seen.has(isbn)) {
      isbns.push(isbn);
      seen.add(isbn);
    }
  }
  if (isbns.length === 0) return [...items];
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const lookup = await bulkLookupByIsbn(isbns, log, signal);
  return items.map((item) => {
    const isbn = isbnFromIdentifiers(item);
    if (!isbn) return item;
    const book = lookup.get(isbn);
    if (!book) return item;
    let enriched = item;
    if (!enriched.description && descriptionFromIsbndb(book)) {
      enriched = { ...enriched, description: descriptionFromIsbndb(book) };
    }
    if (!enriched.coverImageUrl) {
      const cover = coverFromImage(book.image);
      if (cover) enriched = { ...enriched, coverImageUrl: cover };
    }
    if (!enriched.publishedYear) {
      const year = yearFromDatePublished(book.date_published);
      if (year) enriched = { ...enriched, publishedYear: year };
    }
    if (!enriched.language && book.language) {
      enriched = { ...enriched, language: book.language };
    }
    return enriched;
  });
}

export async function enrichEditions(
  items: readonly EditionItem[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<EditionItem[]> {
  return enrichEditionsInternal(items, log, externalSignal);
}

export async function enrichWorks(
  items: readonly WorkItem[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<WorkItem[]> {
  if (!process.env.ISBNDB_API_KEY) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn({ stage: 'isbndb-enricher' }, 'ISBNDB_API_KEY is not set; ISBNDb enrichment disabled');
    }
    return [...items];
  }
  const isbns: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const id of item.identifiers) {
      if (id.resource !== 'isbn13' && id.resource !== 'isbn10' && id.resource !== 'isbn') continue;
      const clean = id.uri.replace(/^isbn:/, '').replace(/-/g, '');
      if (clean && !seen.has(clean)) {
        isbns.push(clean);
        seen.add(clean);
      }
    }
  }
  if (isbns.length === 0) return [...items];
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const lookup = await bulkLookupByIsbn(isbns, log, signal);
  return items.map((item) => {
    let enriched = item;
    let matched: IsbndbBook | undefined;
    for (const id of item.identifiers) {
      if (id.resource !== 'isbn13' && id.resource !== 'isbn10' && id.resource !== 'isbn') continue;
      const clean = id.uri.replace(/^isbn:/, '').replace(/-/g, '');
      if (clean && lookup.has(clean)) {
        matched = lookup.get(clean);
        break;
      }
    }
    if (!matched) return enriched;
    if (enriched.subjects.length === 0 && matched.subjects) {
      enriched = { ...enriched, subjects: matched.subjects.filter((s): s is string => typeof s === 'string') };
    }
    if (!enriched.firstPublishedYear) {
      const year = yearFromDatePublished(matched.date_published);
      if (year) enriched = { ...enriched, firstPublishedYear: year };
    }
    if (!enriched.originalLanguage && matched.language) {
      enriched = { ...enriched, originalLanguage: matched.language };
    }
    if (!enriched.description && descriptionFromIsbndb(matched)) {
      enriched = { ...enriched, description: descriptionFromIsbndb(matched) };
    }
    return enriched;
  });
}

export async function getBookByIsbn(isbn: string, log: Logger, signal?: AbortSignal): Promise<IsbndbBook | null> {
  if (!process.env.ISBNDB_API_KEY) return null;
  const clean = isbnFromQuery(isbn);
  if (!clean) return null;
  const s = signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const res = await isbndbFetch<IsbndbSingleResponse>(`${BASE}/book/${encodeURIComponent(clean)}`, log, s);
  return res?.book ?? null;
}
