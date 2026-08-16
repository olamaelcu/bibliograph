import type { MergeCandidate } from '../merge.js';
import { identifierResource, sourceKeySlug } from '../slugs.js';
import { normalizeIsbn } from '../isbn.js';
import { tsvField } from '../../dump/tsv.js';
import { contributorIdentifiersAdapter, identifierTaken, workIdentifiersAdapter, type PkAdapter } from '../identifiers.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';

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

export function text(v: string | { value?: string } | undefined): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : (v.value ?? null);
}

export function unixSecondsOrNull(date: string | undefined): string | null {
  if (!date) return null;
  const ms = new Date(date).getTime();
  if (!Number.isFinite(ms)) return null;
  return String(Math.floor(ms / 1000));
}

function olIsbn(ed: OlEdition): Array<{ resource: string; url: string }> {
  const out: Array<{ resource: string; url: string }> = [];
  for (const isbn of [...(ed.isbn_13 ?? []), ...(ed.isbn_10 ?? [])]) {
    if (!isbn) continue;
    const normalized = normalizeIsbn(isbn);
    if (!normalized) continue;
    out.push({
      resource: identifierResource('isbn', normalized),
      url: `https://openlibrary.org/isbn/${normalized}`,
    });
  }
  return out;
}

export function mapEditionToCandidates(ed: OlEdition): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];
  const isbnIds = olIsbn(ed);
  // A tiny fraction of OL editions reference multiple works; only the first is
  // linked here, so such editions merge onto the first work and the others stay
  // unlinked. Emitting a candidate per work would duplicate the book candidate.
  const workKey = ed.works?.[0]?.key;

  if (workKey) {
    candidates.push({
      entityType: 'work',
      pk: sourceKeySlug(workKey),
      source: 'openlibrary',
      matchName: ed.title ?? null,
      // Editions carry ISBNs, not works — attach each edition's ISBNs to its
      // work too so a work accumulates the ISBN-10/13 of every edition merged
      // into it, not just its own openlibrary: identifier.
      identifiers: [
        { resource: identifierResource('openlibrary', workKey.replace(/^\//, '')), url: `https://openlibrary.org${workKey}` },
        ...isbnIds,
      ],
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

/** Extract the OL key from a raw dump line (item.json's 2nd TSV field) for resume-skip ordering. */
export function olKeyOf(line: string): string | null {
  return tsvField(line, 1);
}

type Database = NodePgDatabase<typeof schema>;

/** True when an OL resource (`openlibrary:authors/OL1A`) is already claimed by someone. */
export async function olResourceExists(db: Database, adapter: PkAdapter, key: string): Promise<boolean> {
  return identifierTaken(db, adapter, `openlibrary:${key.replace(/^\//, '')}`);
}

/** Fast-path predicate for contributors:dump — skip authors already imported by editions. */
export const skipSeenContributors = (db: Database) => (key: string | null) =>
  key != null && olResourceExists(db, contributorIdentifiersAdapter, key);

/** Fast-path predicate for works:dump — skip works already imported by editions. */
export const skipSeenWorks = (db: Database) => (key: string | null) =>
  key != null && olResourceExists(db, workIdentifiersAdapter, key);
