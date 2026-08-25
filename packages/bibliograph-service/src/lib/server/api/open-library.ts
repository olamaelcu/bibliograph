import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout';
import { withRetry } from './retry';
import { openLibraryBreaker } from './breakers';
import { parseEditionKey, parseWorkKey, parseAuthorKey, editionUri, workUri, contributorUri, olidFromEditionRkey, olidFromWorkRkey, olidFromContributorRkey } from '../ol/keys.js';
import type { SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem, Identifier } from '../search/types';

const UA = 'Bibliograph/0.1 (https://biblio.livtet.olamaelcu.net)';

function buildUrl(q: string | undefined, type: 'edition' | 'work' | 'author', limit: number, page: number): string {
  const base = type === 'author' ? 'https://openlibrary.org/search/authors.json' : 'https://openlibrary.org/search.json';
  const u = new URL(base);
  if (q) u.searchParams.set('q', q);
  if (type !== 'author') u.searchParams.set('type', type);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('page', String(page));
  return u.toString();
}

async function fetchJson<T>(url: string, log: Logger, signal: AbortSignal): Promise<T | null> {
  if (!openLibraryBreaker.canCall()) {
    log.warn({ stage: 'open-library-source', breaker: openLibraryBreaker.getState() }, 'breaker open; skipping fetch');
    return null;
  }
  const start = performance.now();
  try {
    const body = await withRetry(async () => {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal });
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`openlibrary ${res.status}: ${text.slice(0, 200)}`) as Error & { status: number };
        (err as Error & { status: number }).status = res.status;
        throw err;
      }
      log.info({ stage: 'open-library-source', url, durationMs }, 'openlibrary ok');
      return res.json() as Promise<T>;
    }, log);
    openLibraryBreaker.recordSuccess();
    return body;
  } catch (err) {
    openLibraryBreaker.recordFailure();
    log.error({ stage: 'open-library-source', err, url }, 'openlibrary fetch failed');
    return null;
  }
}

interface OlSearchResponse<T> {
  numFound?: number;
  start?: number;
  page?: number;
  docs?: T[];
}

interface OlEditionDoc {
  key: string;
  cover_edition_key?: string;
  title: string;
  subtitle?: string;
  first_publish_year?: number;
  publish_year?: number[];
  place?: string[];
  language?: string[];
  isbn?: string[];
  cover_i?: number;
  description?: string | { value: string };
}

interface OlWorkDoc {
  key: string;
  title: string;
  subtitle?: string;
  first_publish_year?: number;
  original_languages?: string[];
  subject?: string[];
  description?: string | { value: string };
  cover_i?: number;
}

interface OlAuthorDoc { key: string; name: string; birth_date?: string; death_date?: string; top_work?: string; work_count?: number; alternate_names?: string[]; }

function coverUrl(coverId: number | undefined): string | undefined {
  if (coverId === undefined) return undefined;
  return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
}

function extractDescription(d: string | { value: string } | undefined): string | undefined {
  if (typeof d === 'string') return d;
  if (d && typeof d.value === 'string') return d.value;
  return undefined;
}

function yearFromDate(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const m = /^(\d{4})/.exec(d);
  return m ? Number(m[1]) : undefined;
}

function makeOlIdentifier(key: string): Identifier {
  let uri: string;
  if (key.startsWith('/books/') || key.startsWith('/works/') || key.startsWith('/authors/')) {
    uri = `https://openlibrary.org${key}`;
  } else if (key.startsWith('OL') && key.endsWith('A')) {
    uri = `https://openlibrary.org/authors/${key}`;
  } else if (key.startsWith('OL') && key.endsWith('M')) {
    uri = `https://openlibrary.org/books/${key}`;
  } else if (key.startsWith('OL') && key.endsWith('W')) {
    uri = `https://openlibrary.org/works/${key}`;
  } else {
    uri = `https://openlibrary.org${key}`;
  }
  return { uri, resource: 'openlibrary' };
}

function isbnIdentifier(isbn: string): Identifier {
  const clean = isbn.replace(/-/g, '');
  const resource = clean.length === 13 ? 'isbn13' : clean.length === 10 ? 'isbn10' : 'isbn';
  return { uri: `isbn:${clean}`, resource };
}

function isbnFromIdentifiers(item: EditionItem): string | undefined {
  for (const id of item.identifiers) {
    if (id.resource === 'isbn13' || id.resource === 'isbn10' || id.resource === 'isbn') {
      return id.uri.replace(/^isbn:/, '');
    }
  }
  return undefined;
}

async function enrichOneEdition(item: EditionItem, log: Logger, signal: AbortSignal): Promise<EditionItem> {
  const isbn = isbnFromIdentifiers(item);
  if (!isbn) return item;
  const url = buildUrl(`isbn:${isbn}`, 'edition', 1, 1);
  const data = await fetchJson<OlSearchResponse<OlEditionDoc>>(url, log, signal);
  const doc = data?.docs?.[0];
  if (!doc) return item;
  let enriched = item;
  if (!enriched.description) {
    const desc = extractDescription(doc.description);
    if (desc) enriched = { ...enriched, description: desc };
  }
  if (!enriched.coverImageUrl && doc.cover_i !== undefined) {
    enriched = { ...enriched, coverImageUrl: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` };
  }
  if (!enriched.place && doc.place?.[0]) {
    enriched = { ...enriched, place: doc.place[0] };
  }
  if (!enriched.publishedYear && doc.first_publish_year) {
    enriched = { ...enriched, publishedYear: doc.first_publish_year };
  }
  if (!enriched.language && doc.language?.[0]) {
    enriched = { ...enriched, language: doc.language[0] };
  }
  log.info({ stage: 'open-library-enricher', isbn, uri: enriched.uri }, 'ol enrich ok');
  return enriched;
}

export async function enrichEditions(
  items: readonly EditionItem[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<EditionItem[]> {
  const CONCURRENCY = 8;
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const out: EditionItem[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      if (!item) return;
      out[i] = await enrichOneEdition(item, log, signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()));
  return out;
}

async function enrichOneWork(item: WorkItem, log: Logger, signal: AbortSignal): Promise<WorkItem> {
  const title = item.title;
  if (!title) return item;
  const url = buildUrl(title, 'work', 1, 1);
  const data = await fetchJson<OlSearchResponse<OlWorkDoc>>(url, log, signal);
  const doc = data?.docs?.[0];
  if (!doc) return item;
  let enriched = item;
  if (!enriched.description) {
    const desc = extractDescription(doc.description);
    if (desc) enriched = { ...enriched, description: desc };
  }
  if (enriched.subjects.length === 0 && doc.subject) {
    enriched = { ...enriched, subjects: doc.subject };
  }
  if (!enriched.firstPublishedYear && doc.first_publish_year) {
    enriched = { ...enriched, firstPublishedYear: doc.first_publish_year };
  }
  log.info({ stage: 'open-library-enricher', title, uri: enriched.uri }, 'ol enrich ok');
  return enriched;
}

export async function enrichWorks(
  items: readonly WorkItem[],
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<WorkItem[]> {
  const CONCURRENCY = 8;
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const out: WorkItem[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      if (!item) return;
      out[i] = await enrichOneWork(item, log, signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()));
  return out;
}

export async function searchEditions(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<EditionItem>> {
  const limit = Math.min(query.limit, 100);
  const page = 1;
  const url = buildUrl(query.q, 'edition', limit, page);
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await fetchJson<OlSearchResponse<OlEditionDoc>>(url, log, signal);
  if (!data) return { items: [], total: 0 };
  const createdAt = new Date().toISOString();
  const items: EditionItem[] = [];
  for (const d of data.docs ?? []) {
    const editionKey = d.cover_edition_key
      ? (d.cover_edition_key.startsWith('/') ? d.cover_edition_key : `/books/${d.cover_edition_key}`)
      : d.key;
    if (!editionKey.startsWith('/books/')) {
      log.warn({ stage: 'open-library-source', key: d.key, cover_edition_key: d.cover_edition_key }, 'skip work-only doc with no cover edition');
      continue;
    }
    try {
      const olid = parseEditionKey(editionKey);
      const identifiers: Identifier[] = [makeOlIdentifier(editionKey)];
      if (d.isbn) {
        for (const raw of d.isbn.slice(0, 5)) {
          identifiers.push(isbnIdentifier(raw));
        }
      }
      const year = d.first_publish_year ?? d.publish_year?.[0];
      items.push({
        uri: editionUri(olid),
        title: d.title,
        subtitle: d.subtitle,
        publishedYear: year,
        place: d.place?.[0] as string | undefined,
        language: d.language?.[0] as string | undefined,
        description: extractDescription(d.description),
        coverImageUrl: coverUrl(d.cover_i),
        identifiers,
        contributors: [],
        createdAt,
      });
    } catch (err) {
      log.warn({ stage: 'open-library-source', key: d.key, cover_edition_key: d.cover_edition_key, err: String(err) }, 'skip malformed edition doc');
    }
  }
  return { items, total: data.numFound ?? 0 };
}

export async function searchWorks(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<WorkItem>> {
  const limit = Math.min(query.limit, 100);
  const page = 1;
  const url = buildUrl(query.q, 'work', limit, page);
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await fetchJson<OlSearchResponse<OlWorkDoc>>(url, log, signal);
  if (!data) return { items: [], total: 0 };
  const createdAt = new Date().toISOString();
  const items: WorkItem[] = [];
  for (const d of data.docs ?? []) {
    try {
      const olid = parseWorkKey(d.key);
      items.push({
        uri: workUri(olid),
        title: d.title,
        subtitle: d.subtitle,
        firstPublishedYear: d.first_publish_year,
        originalLanguage: d.original_languages?.[0] as string | undefined,
        subjects: d.subject ?? [],
        description: extractDescription(d.description),
        contributors: [],
        identifiers: [makeOlIdentifier(d.key)],
        createdAt,
      });
    } catch (err) {
      log.warn({ stage: 'open-library-source', key: d.key, err: String(err) }, 'skip malformed work doc');
    }
  }
  return { items, total: data.numFound ?? 0 };
}

export async function searchContributors(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<ContributorItem>> {
  const limit = Math.min(query.limit, 100);
  const page = 1;
  const url = buildUrl(query.q, 'author', limit, page);
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await fetchJson<OlSearchResponse<OlAuthorDoc>>(url, log, signal);
  if (!data) return { items: [], total: 0 };
  const createdAt = new Date().toISOString();
  const items: ContributorItem[] = [];
  for (const d of data.docs ?? []) {
    try {
      const olid = parseAuthorKey(d.key);
      const aliases = d.alternate_names ?? [];
      items.push({
        uri: contributorUri(olid),
        name: d.name,
        aliases,
        bornYear: yearFromDate(d.birth_date),
        diedYear: yearFromDate(d.death_date),
        identifiers: [makeOlIdentifier(d.key)],
        createdAt,
      });
    } catch (err) {
      log.warn({ stage: 'open-library-source', key: d.key, err: String(err) }, 'skip malformed contributor doc');
    }
  }
  return { items, total: data.numFound ?? 0 };
}

export async function getEditionByRkey(rkey: string, log: Logger, signal?: AbortSignal): Promise<EditionItem | null> {
  let olid: string;
  try { olid = olidFromEditionRkey(rkey); } catch { return null; }
  return getEditionByOlid(olid, log, signal);
}

async function getEditionByOlid(olid: string, log: Logger, signal?: AbortSignal): Promise<EditionItem | null> {
  const url = `https://openlibrary.org/books/${olid}.json`;
  const s = signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const raw = await fetchJson<OlEditionDoc & { key: string; title: string }>(url, log, s);
  if (!raw) return null;
  const parsedOlid = parseEditionKey(raw.key);
  const identifiers: Identifier[] = [makeOlIdentifier(raw.key)];
  return {
    uri: editionUri(parsedOlid),
    title: raw.title,
    subtitle: raw.subtitle,
    publishedYear: raw.first_publish_year ?? raw.publish_year?.[0],
    place: raw.place?.[0] as string | undefined,
    language: raw.language?.[0] as string | undefined,
    description: extractDescription(raw.description),
    coverImageUrl: coverUrl(raw.cover_i),
    identifiers,
    contributors: [],
    createdAt: new Date().toISOString(),
  };
}

export async function getWorkByRkey(rkey: string, log: Logger, signal?: AbortSignal): Promise<WorkItem | null> {
  let olid: string;
  try { olid = olidFromWorkRkey(rkey); } catch { return null; }
  const url = `https://openlibrary.org/works/${olid}.json`;
  const s = signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const raw = await fetchJson<OlWorkDoc>(url, log, s);
  if (!raw) return null;
  const parsed = parseWorkKey(raw.key);
  return {
    uri: workUri(parsed),
    title: raw.title,
    subtitle: raw.subtitle,
    firstPublishedYear: raw.first_publish_year,
    originalLanguage: raw.original_languages?.[0] as string | undefined,
    subjects: raw.subject ?? [],
    description: extractDescription(raw.description),
    contributors: [],
    identifiers: [makeOlIdentifier(raw.key)],
    createdAt: new Date().toISOString(),
  };
}

export async function getContributorByRkey(rkey: string, log: Logger, signal?: AbortSignal): Promise<ContributorItem | null> {
  let olid: string;
  try { olid = olidFromContributorRkey(rkey); } catch { return null; }
  const url = `https://openlibrary.org/authors/${olid}.json`;
  const s = signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const raw = await fetchJson<OlAuthorDoc & { key: string }>(url, log, s);
  if (!raw) return null;
  const parsed = parseAuthorKey(raw.key);
  return {
    uri: contributorUri(parsed),
    name: raw.name,
    aliases: raw.alternate_names ?? [],
    bornYear: yearFromDate(raw.birth_date),
    diedYear: yearFromDate(raw.death_date),
    identifiers: [makeOlIdentifier(raw.key)],
    createdAt: new Date().toISOString(),
  };
}