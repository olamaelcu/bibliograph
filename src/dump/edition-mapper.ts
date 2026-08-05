import type { BookData } from '../providers/interface.js';

export interface DumpEditionRecord {
  key: string;
  type: string;
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

const COVER_BASE = 'https://covers.openlibrary.org/b/id';

export function toBookData(record: DumpEditionRecord): BookData | null {
  const isbn13 = record.isbn_13?.[0];
  const isbn10 = record.isbn_10?.[0];
  if (!isbn13 && !isbn10) return null;

  const categories =
    record.subjects?.slice(0, 5) ??
    (record.subject_places ? record.subject_places.slice(0, 5) : undefined);

  return {
    title: record.title ?? 'Unknown Title',
    author: record.authors?.[0]?.name ?? 'Unknown',
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
