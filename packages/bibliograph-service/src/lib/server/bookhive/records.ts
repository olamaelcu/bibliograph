import {
  BOOKHIVE_BOOK_COLLECTION,
  bhEditionUri,
  bookhiveCatalogUri,
  hiveIdFromCatalogUri,
  isHiveId,
} from './keys';

/**
 * Normalization for `buzz.bookhive.book` records — Bookhive's per-user "my copy
 * of this book" record. One record carries three things Bibliograph cares
 * about, all inline:
 *
 * - `review` (free text) + `stars` (1-10) → a Bibliograph `bookReview`
 * - `status` → a `bookShelfMetadata#status` reading status
 * - `hiveBookUri` → the Bookhive catalog record, which is also the `bookhive`
 *   identifier Bibliograph stores on the edition (see `catalog.ts`)
 *
 * The record itself is never rewritten: both views are derived at read time.
 */

export type ReadingStatus = 'reading' | 'to-read' | 'read' | 'dnf';

export interface BookhiveShelf {
  rkey: string;
  status: ReadingStatus;
  name: string;
}

const STATUS_SHELVES: Record<string, BookhiveShelf> = {
  'buzz.bookhive.defs#reading': { rkey: 'reading', status: 'reading', name: 'Currently Reading' },
  'buzz.bookhive.defs#finished': { rkey: 'read', status: 'read', name: 'Read' },
  'buzz.bookhive.defs#wantToRead': { rkey: 'to-read', status: 'to-read', name: 'To Read' },
  'buzz.bookhive.defs#abandoned': { rkey: 'dnf', status: 'dnf', name: 'Did Not Finish' },
};

export interface NormalizedBookhiveBook {
  /** at-uri of the Bookhive catalog record — the Constellation backlink subject. */
  subjectUri: string | null;
  /** `bh.`-keyed Bibliograph edition uri, when the hive id is usable. */
  editionUri: string | null;
  review: { text: string; rating?: number; createdAt?: string } | null;
  shelf: BookhiveShelf | null;
}

export function shelfForBookhiveStatus(status: unknown): BookhiveShelf | null {
  return typeof status === 'string' ? (STATUS_SHELVES[status] ?? null) : null;
}

/** Bookhive records the catalog record via `hiveBookUri`; `hiveId` is the fallback. */
function subjectFor(value: Record<string, unknown>): string | null {
  if (typeof value.hiveBookUri === 'string') {
    const hiveId = hiveIdFromCatalogUri(value.hiveBookUri);
    if (hiveId) return value.hiveBookUri;
  }
  if (typeof value.hiveId === 'string' && isHiveId(value.hiveId)) {
    return bookhiveCatalogUri(value.hiveId);
  }
  return null;
}

export function normalizeBookhiveBook(value: unknown): NormalizedBookhiveBook {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const subjectUri = subjectFor(v);
  const hiveId = subjectUri ? hiveIdFromCatalogUri(subjectUri) : null;
  const editionUri = hiveId ? bhEditionUri(hiveId) : null;

  const text = typeof v.review === 'string' ? v.review.trim() : '';
  const stars = v.stars;
  const createdAt = typeof v.createdAt === 'string' ? v.createdAt : undefined;
  const review = text === ''
    ? null
    : {
        text: v.review as string,
        ...(typeof stars === 'number' && Number.isInteger(stars) && stars >= 1 && stars <= 10
          ? { rating: stars }
          : {}),
        ...(createdAt ? { createdAt } : {}),
      };

  return { subjectUri, editionUri, review, shelf: shelfForBookhiveStatus(v.status) };
}

/**
 * Constellation indexes the `hiveBookUri` leaf, so reviews/shelving for a catalog
 * record are found with this source. Kept next to the normalizer because the
 * pair is meaningless apart.
 */
export const BOOKHIVE_BACKLINK_SOURCE = `${BOOKHIVE_BOOK_COLLECTION}:hiveBookUri`;
