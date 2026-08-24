import type { Logger } from 'pino';
import { UPSTREAM_TIMEOUT_MS } from './timeout';
import { withRetry } from './retry';
import { openLibraryBreaker } from './breakers';
import { PUBLISHER_DID } from '../did';
import type { SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem, Identifier } from '../search/types';

const UA = 'Bibliograph/0.1 (https://biblio.livtet.olamaelcu.net)';

function buildUrl(q: string | undefined, type: 'edition' | 'work' | 'author', limit: number, page: number): string {
  const u = new URL('https://openlibrary.org/search.json');
  if (q) u.searchParams.set('q', q);
  u.searchParams.set('type', type);
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

interface OlEditionDoc { key: string; title: string; subtitle?: string; first_publish_year?: number; publish_year?: number[]; place?: string[]; language?: string[]; isbn?: string[]; cover_i?: number; description?: string | { value: string }; }
interface OlWorkDoc { key: string; title: string; subtitle?: string; first_publish_year?: number; original_languages?: string[]; subject?: string[]; description?: string | { value: string }; cover_i?: number; }
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
  return { uri: `https://openlibrary.org${key}`, resource: 'openlibrary' };
}

function makeEditionUri(key: string): string {
  const olId = key.replace(/^\/books\//, '');
  return `at://${PUBLISHER_DID}/community.lexicon.book.edition/ol.${olId}`;
}

function makeWorkUri(key: string): string {
  const olId = key.replace(/^\/works\//, '');
  return `at://${PUBLISHER_DID}/community.lexicon.book.work/ol.${olId}`;
}

function makeAuthorUri(key: string): string {
  const olId = key.replace(/^\/authors\//, '');
  return `at://${PUBLISHER_DID}/community.lexicon.book.contributor/ol.${olId}`;
}

export async function searchEditions(
  query: SearchQuery,
  log: Logger,
  externalSignal?: AbortSignal,
): Promise<SearchResult<EditionItem>> {
  const limit = Math.min(query.limit, 100);
  const page = 1; // cursor-driven pagination deferred to the orchestrator
  const url = buildUrl(query.q, 'edition', limit, page);
  const signal = externalSignal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const data = await fetchJson<OlSearchResponse<OlEditionDoc>>(url, log, signal);
  if (!data) return { items: [], total: 0 };
  const createdAt = new Date().toISOString();
  const items: EditionItem[] = (data.docs ?? []).map((d) => {
    const identifiers: Identifier[] = [makeOlIdentifier(d.key)];
    if (d.isbn) for (const raw of d.isbn.slice(0, 5)) {
      const i = raw.replace(/-/g, '');
      const resource = i.length === 13 ? 'isbn13' : i.length === 10 ? 'isbn10' : 'isbn';
      identifiers.push({ uri: `isbn:${i}`, resource });
    }
    const year = d.first_publish_year ?? d.publish_year?.[0];
    return {
      uri: makeEditionUri(d.key),
      title: d.title,
      subtitle: d.subtitle,
      publishedYear: year,
      place: d.place?.[0],
      language: d.language?.[0],
      description: extractDescription(d.description),
      coverImageUrl: coverUrl(d.cover_i),
      identifiers,
      contributors: [],
      createdAt,
    };
  });
  // cursor deferred to orchestrator (cursor-driven pagination is a follow-up)
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
  const items: WorkItem[] = (data.docs ?? []).map((d) => ({
    uri: makeWorkUri(d.key),
    title: d.title,
    subtitle: d.subtitle,
    firstPublishedYear: d.first_publish_year,
    originalLanguage: d.original_languages?.[0],
    subjects: d.subject ?? [],
    description: extractDescription(d.description),
    contributors: [],
    identifiers: [makeOlIdentifier(d.key)],
    createdAt,
  }));
  // cursor deferred to orchestrator (cursor-driven pagination is a follow-up)
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
  const items: ContributorItem[] = (data.docs ?? []).map((d) => {
    const aliases = d.alternate_names ?? [];
    return {
      uri: makeAuthorUri(d.key),
      name: d.name,
      aliases,
      bornYear: yearFromDate(d.birth_date),
      diedYear: yearFromDate(d.death_date),
      identifiers: [makeOlIdentifier(d.key)],
      createdAt,
    };
  });
  // cursor deferred to orchestrator (cursor-driven pagination is a follow-up)
  return { items, total: data.numFound ?? 0 };
}