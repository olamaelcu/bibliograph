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
  author: string;
  hiveId: string;
  isbn?: string;
  description?: string;
  coverUrl?: string;
  categories: string[];
  identifiers: Array<{ type: string; value: string }>;
  contributors: BookhiveMappedContributor[];
}

const BASE32 = '234567abcdefghijklmnopqrstuvwxyz';

function hiveIdToBookRkey(hiveId: string): string {
  const hex = createHash('sha256').update(hiveId).digest('hex');
  let result = '';
  for (let i = 0; i < 13; i++) {
    const nibble = parseInt(hex[i], 16);
    result += BASE32[nibble & 0x1f];
  }
  return result;
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
    author: names.join(', '),
    hiveId: record.id,
    isbn: idents.isbn13 ?? idents.isbn10 ?? undefined,
    description: record.description,
    coverUrl: record.thumbnail ?? record.cover ?? undefined,
    categories: record.genres ?? [],
    identifiers,
    contributors,
  };
}
