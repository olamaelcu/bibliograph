import type { Identifier } from '../search/types';
import type { EditionRow } from '../db/schema';

/**
 * The lexicon-shaped `community.lexicon.book.edition` value for CID computation.
 *
 * The CID clients receive is the CID of the record as the API serves it, so any
 * writer that changes `identifiers` has to recompute it from this exact shape.
 * Kept out of the job module because the BookHive catalog pass
 * (`scripts/backfill-bookhive-isbns.ts`) writes the same field.
 */
export function editionRecordValueForCid(
  row: EditionRow,
  identifiers: Identifier[],
): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.edition' as const,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    place: row.place ?? undefined,
    publishedYear: row.publishedYear ?? undefined,
    language: row.language ?? undefined,
    coverImageUrl: row.coverImageUrl ?? undefined,
    contributors: row.contributors,
    identifiers,
    description: row.description ?? undefined,
    pages: row.pages ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}
