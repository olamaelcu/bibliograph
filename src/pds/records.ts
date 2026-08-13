import type { books, contributors, contributorTypes } from '../db/schema.js';

type BookRow = typeof books.$inferSelect;
type ContributorRow = typeof contributors.$inferSelect;
type ContributorTypeRow = typeof contributorTypes.$inferSelect;

/**
 * AT Protocol record values, shaped to match the lex in
 * `lexicons/community/lexicon/book/{book,contributor,contributor/type}.json`.
 *
 * The values stored in the SQLite tables carry AppView-only admin fields
 * (status, deduplicationHash, bookTitle/bookAuthor denormalizations,
 * createdAt/updatedAt bookkeeping). Those MUST NOT appear in the record
 * value returned over XRPC — only the lex-defined fields do. Anything else
 * would change the CID and break downstream consumers.
 *
 * Both write-time (CID computation in `cidForRecord`) and read-time
 * (the `getRecord` / `listRecords` XRPC handlers) MUST go through the
 * serializers in this module. If you find yourself building a record
 * value inline, you almost certainly want to add a serializer here.
 */

export interface BookRecordValue {
  $type: 'community.lexicon.book.book';
  title: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  isbn?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  language?: string;
  categories?: string[];
  coverUrl?: string;
  contributors?: Array<{
    contributor?: { uri?: string; cid?: string };
    role?: { uri?: string; cid?: string };
    order?: number;
  }>;
}

export function serializeBook(row: BookRow): BookRecordValue {
  const value: BookRecordValue = {
    $type: 'community.lexicon.book.book',
    title: row.title,
    author: row.author,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.isbn) value.isbn = row.isbn;
  if (row.publishedDate) value.publishedDate = row.publishedDate;
  if (row.description) value.description = row.description;
  if (row.pageCount != null) value.pageCount = row.pageCount;
  if (row.language && row.language !== 'en') value.language = row.language;
  if (Array.isArray(row.categories) && row.categories.length > 0) value.categories = row.categories;
  if (row.coverUrl) value.coverUrl = row.coverUrl;
  if (Array.isArray(row.contributors) && row.contributors.length > 0) {
    value.contributors = row.contributors;
  }
  return value;
}

export interface ContributorRecordValue {
  $type: 'community.lexicon.book.contributor';
  name: string;
  createdAt: string;
  altNames?: string[];
  images?: Array<{ url: string; alt?: string }>;
  identifiers?: Array<{ type: string; value: string }>;
  bio?: string;
}

export function serializeContributor(row: ContributorRow): ContributorRecordValue {
  const value: ContributorRecordValue = {
    $type: 'community.lexicon.book.contributor',
    name: row.name,
    createdAt: row.createdAt,
  };
  if (Array.isArray(row.altNames) && row.altNames.length > 0) value.altNames = row.altNames;
  if (Array.isArray(row.images) && row.images.length > 0) value.images = row.images;
  if (Array.isArray(row.identifiers) && row.identifiers.length > 0) {
    value.identifiers = row.identifiers;
  }
  if (row.bio) value.bio = row.bio;
  return value;
}

export interface ContributorTypeRecordValue {
  $type: 'community.lexicon.book.contributor.type';
  name: string;
  createdAt: string;
  description?: string;
}

export function serializeContributorType(row: ContributorTypeRow): ContributorTypeRecordValue {
  const value: ContributorTypeRecordValue = {
    $type: 'community.lexicon.book.contributor.type',
    name: row.name,
    createdAt: row.createdAt,
  };
  if (row.description) value.description = row.description;
  return value;
}