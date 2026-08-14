import type { MergeCandidate } from '../merge.js';
import { identifierResource, sourceKeySlug } from '../slugs.js';

export interface OlEdition {
  key: string;
  title?: string;
  subtitle?: string;
  publish_date?: string;
  description?: string | { value?: string };
  covers?: number[];
  works?: Array<{ key?: string }>;
  authors?: Array<{ key?: string; name?: string }>;
  isbn_13?: string[];
  isbn_10?: string[];
  physical_format?: string;
}

export interface OlWork {
  key: string;
  title?: string;
  description?: string | { value?: string };
  first_publish_date?: string;
}

export interface OlAuthor {
  key: string;
  name?: string;
  personal_name?: string;
  bio?: string | { value?: string };
  birth_date?: string;
  death_date?: string;
  photos?: number[];
}

function text(v: string | { value?: string } | undefined): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : (v.value ?? null);
}

function unixSecondsOrNull(date: string | undefined): string | null {
  if (!date) return null;
  const ms = new Date(date).getTime();
  if (!Number.isFinite(ms)) return null;
  return String(Math.floor(ms / 1000));
}

function olIsbn(ed: OlEdition): Array<{ resource: string; url: string }> {
  const out: Array<{ resource: string; url: string }> = [];
  for (const isbn of [...(ed.isbn_13 ?? []), ...(ed.isbn_10 ?? [])]) {
    if (!isbn) continue;
    out.push({
      resource: identifierResource('isbn', isbn),
      url: `https://openlibrary.org/isbn/${isbn}`,
    });
  }
  return out;
}

export function mapEditionToCandidates(ed: OlEdition): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];
  const isbnIds = olIsbn(ed);
  const workKey = ed.works?.[0]?.key;

  if (workKey) {
    candidates.push({
      entityType: 'work',
      pk: sourceKeySlug(workKey),
      source: 'openlibrary',
      matchName: ed.title ?? null,
      identifiers: [{ resource: identifierResource('openlibrary', workKey.replace(/^\//, '')), url: `https://openlibrary.org${workKey}` }],
      fields: {
        title: ed.title ?? null,
        description: text(ed.description),
        originalPublishDate: unixSecondsOrNull(ed.publish_date),
      },
    });
  }

	for (const author of ed.authors ?? []) {
		if (!author.key || !author.name) continue; // authoritative contributor comes from the authors dump
		candidates.push({
			entityType: 'contributor',
			pk: sourceKeySlug(author.key),
			source: 'openlibrary',
			matchName: author.name,
			identifiers: [{ resource: identifierResource('openlibrary', author.key.replace(/^\//, '')), url: `https://openlibrary.org${author.key}` }],
			fields: { name: author.name },
		});
	}

  candidates.push({
    entityType: 'book',
    pk: sourceKeySlug(ed.key),
    source: 'openlibrary',
    matchName: ed.title ?? null,
    identifiers: [
      { resource: identifierResource('openlibrary', ed.key.replace(/^\//, '')), url: `https://openlibrary.org${ed.key}` },
      ...isbnIds,
    ],
    fields: {
      title: ed.title ?? null,
      description: text(ed.description),
      publishDate: unixSecondsOrNull(ed.publish_date),
      workPk: workKey ? sourceKeySlug(workKey) : null,
    },
  });

  return candidates;
}

export function mapWorkToCandidate(w: OlWork): MergeCandidate {
  return {
    entityType: 'work',
    pk: sourceKeySlug(w.key),
    source: 'openlibrary',
    matchName: w.title ?? null,
    identifiers: [{ resource: identifierResource('openlibrary', w.key.replace(/^\//, '')), url: `https://openlibrary.org${w.key}` }],
    fields: {
      title: w.title ?? null,
      description: text(w.description),
      originalPublishDate: unixSecondsOrNull(w.first_publish_date),
    },
  };
}

export function mapAuthorToCandidate(a: OlAuthor): MergeCandidate {
  return {
    entityType: 'contributor',
    pk: sourceKeySlug(a.key),
    source: 'openlibrary',
    matchName: a.name ?? null,
    identifiers: [{ resource: identifierResource('openlibrary', a.key.replace(/^\//, '')), url: `https://openlibrary.org${a.key}` }],
    fields: {
      name: a.name ?? a.personal_name ?? null,
      sortName: a.personal_name ?? null,
      bio: text(a.bio),
    },
  };
}

/** Extract the OL key from TSV fields[1] for resume-skip ordering. */
export function olKeyOf(fields: string[]): string | null {
  return fields[1] ?? null;
}
