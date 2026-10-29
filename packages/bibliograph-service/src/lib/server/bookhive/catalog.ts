import type { ContributionEntry, EditionItem, Identifier } from '../search/types';
import {
  BOOKHIVE_CATALOG_COLLECTION,
  BOOKHIVE_DID,
  BOOKHIVE_PDS,
  bhEditionUri,
  bookhiveCatalogUri,
  goodreadsUri,
  isHiveId,
} from './keys';

/**
 * `buzz.bookhive.catalogBook` → `community.lexicon.book.edition` mapping.
 *
 * Bookhive's catalog is Goodreads-derived, so what it gives us is thinner than
 * OpenLibrary: a title, an author *string*, a cover URL, an average rating and
 * the upstream source id. Two consequences:
 *
 * - `authors` cannot become `contributors` on its own — the edition lexicon
 *   wants strongRefs to contributor records. Callers that resolve those names
 *   against the catalog pass the resulting contributions in; otherwise the
 *   edition is ingested without contributors rather than with invented ones.
 * - `rating` (average × 100) has nowhere to live on an edition record, so it is
 *   deliberately dropped instead of being smuggled into an unrelated field.
 *
 * The record's own at-uri is preserved as a `bookhive` identifier: it is the
 * subject that Constellation resolves `buzz.bookhive.book:hiveBookUri`
 * backlinks against, i.e. the join key for Bookhive reviews and shelving.
 */

export const BOOKHIVE_PAGE_SIZE = 100;
export const BOOKHIVE_TIMEOUT_MS = 15_000;

export interface CatalogBookRecord {
  id: string;
  title: string;
  authors?: string;
  cover?: string;
  source?: string;
  sourceId?: string;
  rating?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CatalogPage {
  records: Array<{ uri: string; cid: string; value: CatalogBookRecord }>;
  cursor?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Split Bookhive's free-form `authors` string into individual names. */
export function splitAuthors(authors: string | undefined): string[] {
  if (!authors) return [];
  return authors
    .split(/\s*(?:;|\band\b|&)\s*|,\s*/i)
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * Validate + narrow one `catalogBook` value. Returns null when the record cannot
 * produce a valid edition (no usable id, or no title) — ingestion skips those
 * instead of throwing, because a single bad record must not abort a page.
 */
export function parseCatalogBook(value: unknown): CatalogBookRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = str(v.id);
  const title = str(v.title);
  if (!id || !isHiveId(id) || !title) return null;
  const rec: CatalogBookRecord = { id, title };
  const authors = str(v.authors);
  if (authors) rec.authors = authors;
  const cover = str(v.cover) ?? str(v.thumbnail);
  if (cover) rec.cover = cover;
  const source = str(v.source);
  if (source) rec.source = source;
  const sourceId = str(v.sourceId);
  if (sourceId) rec.sourceId = sourceId;
  if (typeof v.rating === 'number' && Number.isFinite(v.rating)) rec.rating = v.rating;
  const createdAt = str(v.createdAt);
  if (createdAt) rec.createdAt = createdAt;
  const updatedAt = str(v.updatedAt);
  if (updatedAt) rec.updatedAt = updatedAt;
  return rec;
}

function identifiersFor(rec: CatalogBookRecord): Identifier[] {
  const identifiers: Identifier[] = [
    { uri: bookhiveCatalogUri(rec.id), resource: 'bookhive' },
  ];
  if (rec.sourceId && rec.source && rec.source.toLowerCase() === 'goodreads') {
    identifiers.push({ uri: goodreadsUri(rec.sourceId), resource: 'goodreads' });
  }
  return identifiers;
}

/**
 * Map a catalog record to an edition ingest item.
 *
 * `contributions` must already be resolved strongRefs (see module comment);
 * pass `[]` when the authors are unknown to the catalog.
 */
export function catalogBookToEditionItem(
  rec: CatalogBookRecord,
  contributions: ContributionEntry[] = [],
): EditionItem | null {
  const createdAt = rec.createdAt ?? rec.updatedAt;
  if (!createdAt) return null;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  return {
    uri: bhEditionUri(rec.id),
    title: rec.title,
    description: undefined,
    coverImageUrl: rec.cover,
    identifiers: identifiersFor(rec),
    contributors: contributions,
    createdAt: created.toISOString(),
  };
}

/** Fetch one page of `buzz.bookhive.catalogBook` from Bookhive's PDS. */
export async function fetchCatalogBooksPage(params: {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<CatalogPage> {
  const url = new URL(`${BOOKHIVE_PDS}/xrpc/com.atproto.repo.listRecords`);
  url.searchParams.set('repo', BOOKHIVE_DID);
  url.searchParams.set('collection', BOOKHIVE_CATALOG_COLLECTION);
  url.searchParams.set('limit', String(Math.min(params.limit ?? BOOKHIVE_PAGE_SIZE, BOOKHIVE_PAGE_SIZE)));
  if (params.cursor) url.searchParams.set('cursor', params.cursor);

  const signal = params.signal ?? AbortSignal.timeout(BOOKHIVE_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    throw new Error(`bookhive listRecords failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    records?: Array<{ uri?: unknown; cid?: unknown; value?: unknown }>;
    cursor?: unknown;
  };
  const records: CatalogPage['records'] = [];
  for (const raw of body.records ?? []) {
    if (typeof raw.uri !== 'string') continue;
    const value = parseCatalogBook(raw.value);
    if (!value) continue;
    records.push({
      uri: raw.uri,
      cid: typeof raw.cid === 'string' ? raw.cid : '',
      value,
    });
  }
  const cursor = typeof body.cursor === 'string' && body.cursor !== '' ? body.cursor : undefined;
  return { records, cursor };
}
