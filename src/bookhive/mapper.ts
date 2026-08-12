import { createHash } from 'node:crypto';

export interface BookhiveCatalogRecord {
  $type?: string;
  id: string;
  title: string;
  authors: string;
  thumbnail?: string;
  cover?: string;
  description?: string;
  genres?: string[];
  identifiers?: {
    hiveId?: string;
    isbn10?: string;
    isbn13?: string;
    goodreadsId?: string;
  };
  source?: string;
  sourceId?: string;
  sourceUrl?: string;
  rating?: number;
  ratingsCount?: number;
  series?: string;
  createdAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

export interface BookhiveMappedContributor {
  name: string;
  order: number;
}

export interface BookhiveMappedBook {
  uri: string;
  did: string;
  title: string;
  hiveId: string;
  isbn?: string;
  description?: string;
  coverUrl?: string;
  categories: string[];
  identifiers: Array<{ type: string; value: string }>;
  contributors: BookhiveMappedContributor[];
}

const BASE32 = '234567abcdefghijklmnopqrstuvwxyz';

export function contentRkey(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  let result = '';
  for (let i = 0; i < 13; i++) {
    const nibble = parseInt(hex[i], 16);
    result += BASE32[nibble & 0x1f];
  }
  return result;
}

function hiveIdToBookRkey(hiveId: string): string {
  return contentRkey(hiveId);
}

function splitAuthors(authors: string): string[] {
  return authors
    .split('\t')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

const DEFAULT_DID = process.env.ATP_SERVICE_DID || 'did:web:localhost';

export interface CatalogBookToBookDataOptions {
  serviceDid?: string;
  sourceUri?: string;
}

export interface BookhiveUserBookRecord {
  $type?: string;
  title?: string;
  authors?: string;
  hiveId?: string;
  hiveBookUri?: string;
  status?: string;
  stars?: number;
  review?: string;
  bookProgress?: {
    percent?: number;
    currentPage?: number;
    totalPages?: number;
    currentChapter?: number;
    totalChapters?: number;
    updatedAt?: string;
  };
  startedAt?: string;
  finishedAt?: string;
  owned?: boolean;
  identifiers?: {
    hiveId?: string;
    isbn10?: string;
    isbn13?: string;
    goodreadsId?: string;
  };
  createdAt?: string;
  [k: string]: unknown;
}

export interface MappedUserBookStatus {
  userDid: string;
  title: string;
  author: string;
  hiveId: string;
  status: string | null;
  rating: number | null;
  progress: number | null;
  bookProgress: {
    percent?: number;
    currentPage?: number;
    totalPages?: number;
    currentChapter?: number;
    totalChapters?: number;
    updatedAt?: string;
  } | null;
  startedAt: string | null;
  finishedAt: string | null;
  review: string | null;
  identifiers: Array<{ type: string; value: string }>;
}

export interface MappedUserBookReview {
  userDid: string;
  title: string;
  author: string;
  text: string;
  rating: number | null;
}

const BOOKHIVE_STATUS_TO_BIBLIOGRAPH: Record<string, string> = {
  'buzz.bookhive.defs#finished': 'read',
  'buzz.bookhive.defs#reading': 'reading',
  'buzz.bookhive.defs#wantToRead': 'to-read',
  'buzz.bookhive.defs#abandoned': 'abandoned',
};

export function bookhiveUserBookToReadingStatus(
  record: BookhiveUserBookRecord,
  opts: { userDid: string },
): MappedUserBookStatus {
  const idents = record.identifiers ?? {};
  const identifiers: Array<{ type: string; value: string }> = [];
  if (record.hiveId) identifiers.push({ type: 'hiveId', value: record.hiveId });
  if (idents.isbn13) identifiers.push({ type: 'isbn13', value: idents.isbn13 });
  if (idents.isbn10) identifiers.push({ type: 'isbn10', value: idents.isbn10 });
  if (idents.goodreadsId)
    identifiers.push({ type: 'goodreadsId', value: idents.goodreadsId });

  const bp = record.bookProgress;
  const stars = typeof record.stars === 'number' ? record.stars : null;
  const rating =
    stars === null ? null : Math.max(1, Math.min(5, Math.round(stars / 2)));

  return {
    userDid: opts.userDid,
    title: record.title ?? '',
    author: splitAuthors(record.authors ?? '').join(', '),
    hiveId: record.hiveId ?? '',
    status: record.status ? (BOOKHIVE_STATUS_TO_BIBLIOGRAPH[record.status] ?? null) : null,
    rating,
    progress: bp && typeof bp.percent === 'number' ? bp.percent : null,
    bookProgress: bp ?? null,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    review: record.review ?? null,
    identifiers,
  };
}

export function bookhiveUserBookToReview(
  record: BookhiveUserBookRecord,
  opts: { userDid: string },
): MappedUserBookReview | null {
  const text = (record.review ?? '').trim();
  if (!text) return null;
  const stars = typeof record.stars === 'number' ? record.stars : null;
  return {
    userDid: opts.userDid,
    title: record.title ?? '',
    author: splitAuthors(record.authors ?? '').join(', '),
    text,
    rating: stars === null ? null : Math.max(1, Math.min(5, Math.round(stars / 2))),
  };
}

export function catalogBookToBookData(
  record: BookhiveCatalogRecord,
  opts: CatalogBookToBookDataOptions = {},
): BookhiveMappedBook {
  const did = opts.serviceDid ?? DEFAULT_DID;
  const identifiers: Array<{ type: string; value: string }> = [];
  const idents = record.identifiers ?? {};
  if (record.id) identifiers.push({ type: 'hiveId', value: record.id });
  if (opts.sourceUri) identifiers.push({ type: 'hiveBookUri', value: opts.sourceUri });
  if (idents.isbn13) identifiers.push({ type: 'isbn13', value: idents.isbn13 });
  if (idents.isbn10) identifiers.push({ type: 'isbn10', value: idents.isbn10 });
  if (idents.goodreadsId)
    identifiers.push({ type: 'goodreadsId', value: idents.goodreadsId });

  const names = splitAuthors(record.authors ?? '');
  const contributors = names.map((name, idx) => ({ name, order: idx }));

  return {
    uri: `at://${did}/community.lexicon.book.book/${hiveIdToBookRkey(record.id)}`,
    did,
    title: record.title,
    hiveId: record.id,
    isbn: idents.isbn13 ?? idents.isbn10 ?? undefined,
    description: record.description,
    coverUrl: record.thumbnail ?? record.cover ?? undefined,
    categories: record.genres ?? [],
    identifiers,
    contributors,
  };
}
