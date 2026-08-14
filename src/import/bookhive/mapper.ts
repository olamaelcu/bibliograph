import type { MergeCandidate } from '../merge.js';
import { identifierResource, sourceKeySlug } from '../slugs.js';
import { normalizeIsbn } from '../isbn.js';

/** FNV-1a 32-bit hash, hex — deterministic fallback for non-ASCII names. */
function hashName(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Slug a contributor name; falls back to a deterministic hash when the name has no ASCII chars. */
function contributorPk(name: string): string {
  try {
    return sourceKeySlug(name);
  } catch {
    return `c-${hashName(name)}`;
  }
}

export interface BookhiveCatalogBook {
  $type?: string;
  /** Record key slug, e.g. bk_zzpdK0fMgbLQYdzPhxwf. */
  id?: string;
  /** Authors as a display string ("Barry Larson") or array of {name}. */
  authors?: string | Array<{ name?: string } | string>;
  title?: string;
  description?: string;
  coverUrl?: string;
  /** Identifier map, e.g. { hiveId: "bk_...", goodreadsId: "53780375", isbn: "..." }. */
  identifiers?: Record<string, string>;
  /** Back-compat: isbn as string or array. */
  isbn?: string | string[];
  /** Back-compat alias for authors. */
  author?: string | Array<{ name?: string } | string>;
  [k: string]: unknown;
}

function authorNames(authors: BookhiveCatalogBook['authors']): Array<{ name: string; role: string }> {
  if (!authors) return [];
  if (typeof authors === 'string') return [{ name: authors, role: 'author' }];
  return authors
    .map((a) => (typeof a === 'string' ? { name: a, role: 'author' } : { name: a.name ?? '', role: 'author' }))
    .filter((a) => a.name.trim().length > 0);
}

function isbns(record: BookhiveCatalogBook): Array<{ resource: string; url: string }> {
  const raw = record.identifiers?.isbn ?? record.isbn;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
    .map((i) => {
      const normalized = normalizeIsbn(i);
      if (!normalized) return null;
      return {
        resource: identifierResource('isbn', normalized),
        url: `https://openlibrary.org/isbn/${normalized}`,
      };
    })
    .filter((i): i is { resource: string; url: string } => i !== null);
}

export function mapCatalogBook(record: BookhiveCatalogBook): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];
  const hiveId = record.identifiers?.hiveId ?? record.id ?? sourceKeySlug(record.title ?? 'untitled');
  const names = authorNames(record.authors ?? record.author);

  for (const { name } of names) {
    candidates.push({
      entityType: 'contributor',
      pk: contributorPk(name),
      source: 'bookhive',
      matchName: name,
      identifiers: [],
      fields: { name },
    });
  }

  candidates.push({
    entityType: 'book',
    pk: sourceKeySlug(hiveId),
    source: 'bookhive',
    matchName: record.title ?? null,
    identifiers: [
      ...(hiveId ? [{ resource: identifierResource('hiveId', hiveId), url: `https://bookhive.buzz/book/${hiveId}` }] : []),
      ...isbns(record),
    ],
    fields: {
      title: record.title ?? null,
      description: record.description ?? null,
      coverUrl: record.coverUrl ?? null,
    },
  });

  return candidates;
}
