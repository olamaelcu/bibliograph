import { cidForLex } from "@atproto/lex-cbor";
import type { LexMap } from "@atproto/lex-data";
import type { EditionRow } from "./db/schema";
import type { Identifier } from "./search/types";

/**
 * The lexicon-shaped edition record, for recomputing the record CID after a
 * backfill changes a value that lives in the record itself (`pages`,
 * `identifiers`, `publishedYear`, `language`).
 * `format` is AppView-only and is intentionally absent.
 */
export function editionRecordValue(
  row: EditionRow,
  overrides: {
    pages?: number | null;
    identifiers?: Identifier[];
    publishedYear?: number | null;
    language?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    $type: "community.lexicon.book.edition" as const,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    place: row.place ?? undefined,
    publishedYear:
      overrides.publishedYear === undefined
        ? (row.publishedYear ?? undefined)
        : (overrides.publishedYear ?? undefined),
    language:
      overrides.language === undefined
        ? (row.language ?? undefined)
        : (overrides.language ?? undefined),
    coverImageUrl: row.coverImageUrl ?? undefined,
    contributors: row.contributors,
    identifiers: overrides.identifiers ?? (row.identifiers as Identifier[]),
    description: row.description ?? undefined,
    pages:
      overrides.pages === undefined
        ? (row.pages ?? undefined)
        : (overrides.pages ?? undefined),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function editionRecordCid(
  row: EditionRow,
  overrides: {
    pages?: number | null;
    identifiers?: Identifier[];
    publishedYear?: number | null;
    language?: string | null;
  } = {},
): Promise<string> {
  const value = editionRecordValue(row, overrides);
  return (await cidForLex(value as unknown as LexMap)).toString();
}
