import type { Logger } from 'pino';
import { fetchJson } from './fetch-json';
import { openLibraryBreaker } from './breakers';
import { UPSTREAM_TIMEOUT_MS } from './timeout';

/** Work search: title → the works a title could mean, with author names. */
const WORK_SEARCH_URL = 'https://openlibrary.org/search.json';
const WORK_FIELDS = 'key,title,author_name,first_publish_year';
const WORKS_PER_QUERY = 3;
/** Each work's editions carry their own ISBN — the precision this module exists for. */
const EDITIONS_PER_WORK = 8;

/** One *edition* search hit: enough to build an ISBN candidate, nothing more. */
export interface OlEditionHit {
  /** Edition key (`/books/OL…M`), display-only. */
  key: string;
  title: string;
  authors: string[];
  publishedYear?: number;
  pages?: number;
  isbns: string[];
}

interface OlWorkDoc {
  key?: string;
  title?: string;
  author_name?: unknown;
  first_publish_year?: unknown;
}

interface OlEditionDoc {
  key?: string;
  title?: string;
  publish_date?: unknown;
  isbn_13?: unknown;
  isbn_10?: unknown;
  number_of_pages?: unknown;
}

/** Non-empty strings from a provider list field; three call sites rely on it. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

async function editionsForWork(
  workKey: string,
  log: Logger,
  signal: AbortSignal,
): Promise<OlEditionDoc[]> {
  const url = new URL(`https://openlibrary.org${workKey}/editions.json`);
  url.searchParams.set('limit', String(EDITIONS_PER_WORK));
  const body = await fetchJson<{ entries?: OlEditionDoc[] }>(url.toString(), log, signal, {
    breaker: openLibraryBreaker,
    provider: 'openlibrary',
    stage: 'isbn-search-ol-editions',
  });
  return Array.isArray(body?.entries) ? body.entries : [];
}

/**
 * Title search restricted to ISBN discovery.
 *
 * Bibliograph removed the full OpenLibrary integration (authority refetch,
 * contributor ingest, cover host) in 0.4.0, but its catalog is still the only
 * free source that returns ISBNs on a title query: Google Books hits often
 * carry none. Work-level search docs aggregate every edition's ISBN, which is
 * exactly the wrong thing to write — a candidate must be an *edition*, so this
 * module resolves each top work's editions and pairs each with its own ISBN.
 */
export async function searchOpenLibraryEditionsByTitle(
  query: string,
  log: Logger,
  signal: AbortSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  limit = 8,
): Promise<OlEditionHit[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  const url = new URL(WORK_SEARCH_URL);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('limit', String(WORKS_PER_QUERY));
  url.searchParams.set('fields', WORK_FIELDS);

  const body = await fetchJson<{ docs?: OlWorkDoc[] }>(url.toString(), log, signal, {
    breaker: openLibraryBreaker,
    provider: 'openlibrary',
    stage: 'isbn-search-ol',
  });
  const works = (body?.docs ?? []).filter(
    (doc): doc is Required<Pick<OlWorkDoc, 'key'>> & OlWorkDoc =>
      typeof doc.key === 'string' && doc.key.startsWith('/works/'),
  );
  if (works.length === 0) return [];

  const editionLists = await Promise.all(
    works.map((work) => editionsForWork(work.key, log, signal).catch(() => [])),
  );

  const hits: OlEditionHit[] = [];
  for (let i = 0; i < works.length; i++) {
    const work = works[i]!;
    const authors = stringList(work.author_name);
    const workYear = typeof work.first_publish_year === 'number' ? work.first_publish_year : undefined;
    for (const edition of editionLists[i] ?? []) {
      const isbns = [...stringList(edition.isbn_13), ...stringList(edition.isbn_10)];
      if (isbns.length === 0) continue;
      const title = typeof edition.title === 'string' && edition.title.trim() !== ''
        ? edition.title.trim()
        : (work.title ?? '');
      if (title === '') continue;
      const yearMatch = typeof edition.publish_date === 'string' ? /\b(\d{4})\b/.exec(edition.publish_date) : null;
      hits.push({
        key: typeof edition.key === 'string' ? edition.key : '',
        title,
        authors,
        publishedYear: yearMatch ? Number(yearMatch[1]) : workYear,
        pages: typeof edition.number_of_pages === 'number' ? edition.number_of_pages : undefined,
        isbns: isbns.slice(0, 2),
      });
    }
  }
  return hits.slice(0, limit);
}
