import type { BookContributor, BookData } from '../providers/interface.js';

export interface DumpEditionRecord {
  key: string;
  type: string | { key: string };
  title?: string;
  authors?: Array<{ key: string; name?: string }>;
  isbn_13?: string[];
  isbn_10?: string[];
  publish_date?: string;
  number_of_pages?: number;
  publishers?: string[];
  subjects?: string[];
  subject_places?: string[];
  covers?: number[];
  [k: string]: unknown;
}

function extractTypeKey(type: unknown): string | null {
  if (typeof type === 'string') return type;
  if (type && typeof type === 'object' && typeof (type as { key?: unknown }).key === 'string') {
    return (type as { key: string }).key;
  }
  return null;
}

function isEditionShape(o: unknown): o is { key: string; type: string; title?: string; authors?: { name?: string }[]; isbn_13?: string[]; isbn_10?: string[]; publish_date?: string; number_of_pages?: number; subjects?: string[]; subject_places?: string[]; covers?: number[] } {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as { key?: unknown; type?: unknown };
  return typeof r.key === 'string' && extractTypeKey(r.type) === '/type/edition';
}

const COVER_BASE = 'https://covers.openlibrary.org/b/id';

export function toBookData(record: DumpEditionRecord): BookData | null {
  if (!isEditionShape(record)) return null;

  const isbn13 = record.isbn_13?.[0];
  const isbn10 = record.isbn_10?.[0];
  if (!isbn13 && !isbn10) return null;

  const categories =
    record.subjects?.slice(0, 5) ??
    (record.subject_places ? record.subject_places.slice(0, 5) : undefined);

  const contributors = toContributors(record.authors);

  return {
    title: record.title ?? 'Unknown Title',
    contributors,
    isbn13,
    isbn10,
    publishedDate: record.publish_date,
    pageCount:
      typeof record.number_of_pages === 'number' ? record.number_of_pages : undefined,
    categories,
    coverUrl:
      typeof record.covers?.[0] === 'number'
        ? `${COVER_BASE}/${record.covers[0]}-M.jpg`
        : undefined,
    identifiers: { openlibrary: record.key },
    sourceProvider: 'openlibrary',
  };
}

export function toContributors(
  authors: DumpEditionRecord['authors'],
): BookContributor[] {
  const out: BookContributor[] = [];
  let i = 0;
  for (const a of authors ?? []) {
    const name = a?.name;
    if (!name) continue;
    out.push({ name, key: a?.key, order: i });
    i += 1;
  }
  if (out.length === 0) {
    return [{ name: 'Unknown', order: 0 }];
  }
  return out;
}

export function extractAuthorKeys(record: DumpEditionRecord): string[] {
  const keys: string[] = [];
  for (const a of record.authors ?? []) {
    if (a?.key) keys.push(a.key);
  }
  return keys;
}
