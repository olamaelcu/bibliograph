import type { Identifier } from '../identifiers';
import type { EditionRow } from '../db/schema';
import { editionRecordValue } from '../edition-record';
import type { Contributor } from '../book-wire';

/**
 * The `community.lexicon.book.edition` value that an identifier write hashes.
 *
 * The CID clients receive is the CID of the record as the API serves it, so a
 * writer that changes `identifiers` has to recompute it from the same shape the
 * response boundary uses — this delegates to `edition-record.ts` so there is
 * exactly one edition record shape in the codebase.
 *
 * Kept as a separate entry point because the BookHive catalog pass
 * (`scripts/backfill-bookhive-catalog.ts`) writes the same field.
 */
export function editionRecordValueForCid(
  row: EditionRow,
  identifiers: Identifier[],
  contributors: readonly Contributor[],
): Record<string, unknown> | null {
  return editionRecordValue(row, { identifiers, contributors });
}
