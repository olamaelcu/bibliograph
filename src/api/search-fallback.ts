import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import type { BookData } from '../providers/interface.js';
import { importBookData } from '../backfill-import.js';
import { computeDeduplicationHash } from '../dedup.js';
import { logger } from '../logger.js';

export type FallbackSource = 'googleBooks' | 'openlibrary' | 'none';

export interface FallbackResult {
  books: BookData[];
  source: FallbackSource;
}

export interface SearchFallbackOptions {
  cap?: number;
}

interface FallbackLog {
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
}

const DEFAULT_CAP = 10;

function normalizeIsbn(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/[\s-]/g, '');
  return stripped.length > 0 ? stripped : undefined;
}

function isIsbnQuery(q: string): boolean {
  return /^[0-9-]+$/.test(q.trim());
}

function dedupKey(book: BookData): { isbn?: string; hash?: string } {
  const isbn = normalizeIsbn(book.isbn13);
  const hash = computeDeduplicationHash(book.title, book.author, book.publishedDate);
  return { isbn, hash };
}

function isDuplicate(candidate: BookData, gbBooks: BookData[]): boolean {
  const cKey = dedupKey(candidate);
  for (const gb of gbBooks) {
    const gKey = dedupKey(gb);
    if (cKey.isbn && gKey.isbn && cKey.isbn === gKey.isbn) return true;
    if (cKey.hash && gKey.hash && cKey.hash === gKey.hash) return true;
  }
  return false;
}

export async function searchFallback(
  db: BetterSQLite3Database<typeof schema>,
  q: string,
  log: FallbackLog,
  opts: SearchFallbackOptions = {},
): Promise<FallbackResult> {
  const cap = opts.cap ?? DEFAULT_CAP;
  const trimmed = q.trim();
  const isbnMode = isIsbnQuery(trimmed);
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  const useGoogleBooks = !!apiKey;

  let gbQueried = false;
  let gbThrew = false;
  let gbBooks: BookData[] = [];

  if (useGoogleBooks) {
    gbQueried = true;
    try {
      const { GoogleBooksProvider } = await import('../providers/googlebooks.js');
      const gb = new GoogleBooksProvider(apiKey as string);
      if (isbnMode) {
        const hit = await gb.searchByIsbn(trimmed);
        gbBooks = hit ? [hit] : [];
      } else {
        gbBooks = await gb.searchByTitle(trimmed);
      }
    } catch (err) {
      gbThrew = true;
      log.error({ err, q: trimmed }, 'searchFallback: Google Books query failed');
    }
  }

  let olQueried = false;
  let olThrew = false;
  let olBooks: BookData[] = [];

  olQueried = true;
  try {
    const { OpenLibraryProvider } = await import('../providers/openlibrary.js');
    const ol = new OpenLibraryProvider();
    if (isbnMode) {
      const hit = await ol.searchByIsbn(trimmed);
      olBooks = hit ? [hit] : [];
    } else {
      olBooks = await ol.searchByTitle(trimmed);
    }
  } catch (err) {
    olThrew = true;
    log.error({ err, q: trimmed }, 'searchFallback: Open Library query failed');
  }

  const olSurvivors = olBooks.filter(item => !isDuplicate(item, gbBooks));
  const merged: BookData[] = [...gbBooks, ...olSurvivors];

  const importedBooks: BookData[] = [];
  const seen = new Set<string>();
  let importedCount = 0;
  let stoppedAtCap = false;

  for (const book of merged) {
    if (importedCount >= cap) {
      stoppedAtCap = true;
      break;
    }
    const dedupType = book.sourceProvider === 'googleBooks' ? 'googleBooks' : 'openlibrary';
    const outcome = await importBookData(db, book, seen, dedupType);
    if (outcome === 'imported') {
      importedCount += 1;
    }
    importedBooks.push(book);
  }

  if (stoppedAtCap) {
    log.warn({ q: trimmed, cap }, 'searchFallback: import cap reached');
  }

  let source: FallbackSource = 'none';
  if (gbQueried && !gbThrew) {
    source = 'googleBooks';
  } else if (olQueried && !olThrew) {
    source = 'openlibrary';
  }

  logger.info(
    { q: trimmed, source, total: merged.length, imported: importedCount },
    'searchFallback complete',
  );

  return { books: importedBooks, source };
}