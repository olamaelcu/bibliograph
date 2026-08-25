import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout';
import { withRetry } from './retry';
import { openLibraryBreaker } from './breakers';
import { editionRkey, parseEditionKey, parseWorkKey, parseAuthorKey, editionUri, workUri, contributorUri } from '../ol/keys.js';
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
  // key formats: /books/OL123M, /works/OL123W, OL123A (bare author OLID)
  let uri: string;
  if (key.startsWith('/books/') || key.startsWith('/works/') || key.startsWith('/authors/')) {
    uri = `https://openlibrary.org${key}`;
  } else if (key.startsWith('OL') && key.endsWith('A')) {
    // Bare author OLID like OL26459A
    uri = `https://openlibrary.org/authors/${key}`;
  } else if (key.startsWith('OL') && key.endsWith('M')) {
    // Bare edition OLID like OL123M
    uri = `https://openlibrary.org/books/${key}`;
  } else if (key.startsWith('OL') && key.endsWith('W')) {
    // Bare work OLID like OL123W
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
    try {
      const editionKey = d.cover_edition_key ? `/books/${d.cover_edition_key}` : d.key;
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