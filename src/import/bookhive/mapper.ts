import type { MergeCandidate } from '../merge.js';
import { identifierResource, sourceKeySlug } from '../slugs.js';
import { normalizeIsbn } from '../isbn.js';

export interface BookhiveCatalogBook {
  $type?: string;
  hiveId?: string;
  title?: string;
  author?: string | Array<{ name?: string } | string>;
  isbn?: string | string[];
  description?: string;
  coverUrl?: string;
  [k: string]: unknown;
}

function authorNames(author: BookhiveCatalogBook['author']): Array<{ name: string; role: string }> {
  if (!author) return [];
  if (typeof author === 'string') return [{ name: author, role: 'author' }];
  return author
    .map((a) => (typeof a === 'string' ? { name: a, role: 'author' } : { name: a.name ?? '', role: 'author' }))
    .filter((a) => a.name.trim().length > 0);
}

function isbns(record: BookhiveCatalogBook): Array<{ resource: string; url: string }> {
  const list = Array.isArray(record.isbn) ? record.isbn : record.isbn ? [record.isbn] : [];
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
  const hiveId = record.hiveId ?? sourceKeySlug(record.title ?? 'untitled');
  const names = authorNames(record.author);

  for (const { name } of names) {
    candidates.push({
      entityType: 'contributor',
      pk: sourceKeySlug(name),
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
      ...(record.hiveId ? [{ resource: identifierResource('hiveId', record.hiveId), url: `https://bookhive.buzz/book/${record.hiveId}` }] : []),
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
