// Manual edition merge.
//
// A librarian decides that two or more catalog rows describe the same book.
// The winner keeps its URI — it is the one every other table and every link
// points at — and absorbs the losing rows' identifiers and contributors. The
// losers are then deleted from the local catalog.
//
// Nothing is published to anyone's repo here: the catalog is a derived view of
// records other people own, so a merge is a local curation decision that a
// re-ingest can rebuild. That is also why the union fields are computed from
// the rows in the database rather than from the request body — the caller only
// picks the winner and which cover/description to keep.

import { eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from './db';
import { editions, type EditionRow } from './db/schema';
import type { DbExecutor } from './stats';

export type EditionIdentifier = EditionRow['identifiers'][number];
export type EditionContributor = EditionRow['contributors'][number];

export interface MergeEditionsResult {
  /** The winning row as it was written back. */
  merged: EditionRow;
  /** URIs of the merged-away rows, in the order they were deleted. */
  deleted: string[];
}

/** A merge is impossible, or shows that the caller's selection is stale. */
export class EditionMergeError extends Error {
  constructor(
    readonly code: 'primary-not-selected' | 'editions-missing',
    message: string,
  ) {
    super(message);
    this.name = 'EditionMergeError';
  }
}

/**
 * Fold every edition in `sourceEditions` into the one identified by
 * `primaryUri`. Pure: no database access, no mutation of the input rows.
 *
 * Identifiers dedupe on `(uri, resource)` and contributors on
 * `(subject.uri, role)`; the first occurrence wins, so the order of
 * `sourceEditions` decides which duplicate's CID is kept and how the unions are
 * ordered. `mergeEditionsInDb` always puts the winner first.
 */
export function computeMergedEdition(
  sourceEditions: readonly EditionRow[],
  primaryUri: string,
  coverImageUrl?: string,
  description?: string,
): EditionRow {
  const primary = sourceEditions.find((edition) => edition.uri === primaryUri);
  if (!primary) throw new EditionMergeError('primary-not-selected', 'primaryUri must be in source editions');

  const identifiers: EditionIdentifier[] = [];
  const seenIdentifiers = new Set<string>();
  const contributors: EditionContributor[] = [];
  const seenContributors = new Set<string>();

  for (const edition of sourceEditions) {
    for (const identifier of edition.identifiers) {
      const key = `${identifier.uri}|${identifier.resource}`;
      if (seenIdentifiers.has(key)) continue;
      seenIdentifiers.add(key);
      identifiers.push({ uri: identifier.uri, resource: identifier.resource });
    }
    for (const contributor of edition.contributors) {
      const key = `${contributor.subject.uri}|${contributor.role}`;
      if (seenContributors.has(key)) continue;
      seenContributors.add(key);
      contributors.push({
        subject: { uri: contributor.subject.uri, cid: contributor.subject.cid },
        role: contributor.role,
      });
    }
  }

  return {
    ...primary,
    identifiers,
    contributors,
    // Omitted means "keep what the winner had"; an empty string means "clear
    // it", which the column stores as NULL.
    coverImageUrl: coverImageUrl === undefined ? primary.coverImageUrl : coverImageUrl || null,
    description: description === undefined ? primary.description : description || null,
  };
}

/**
 * Merge `sourceUris` into `primaryUri` in one transaction: the winner's union
 * fields are rewritten and every other selected row is deleted. All or nothing,
 * so a failure cannot leave half a merge behind.
 *
 * Every URI in `sourceUris` must name an existing row: the caller's selection is
 * the whole premise of the merge, so a stale one is rejected before anything is
 * written rather than quietly merged over.
 */
export async function mergeEditionsInDb(
  db: DbExecutor,
  sourceUris: readonly string[],
  primaryUri: string,
  coverImageUrl?: string,
  description?: string,
): Promise<MergeEditionsResult> {
  if (!sourceUris.includes(primaryUri)) {
    throw new EditionMergeError('primary-not-selected', 'primaryUri must be in source editions');
  }

  const uniqueUris = [...new Set(sourceUris)];

  return db.transaction(async (tx) => {
    const rows = await tx.select().from(editions).where(inArray(editions.uri, uniqueUris));
    const present = new Set(rows.map((row) => row.uri));
    const missing = uniqueUris.filter((uri) => !present.has(uri));
    if (missing.length > 0) {
      throw new EditionMergeError('editions-missing', `No edition row for: ${missing.join(', ')}`);
    }
    const doomed = uniqueUris.filter((uri) => uri !== primaryUri);
    // Returned row order is up to the planner, so put the winner first: it must
    // own the CIDs its duplicates share.
    const ordered = rows
      .filter((row) => row.uri === primaryUri)
      .concat(rows.filter((row) => row.uri !== primaryUri));
    const merged = computeMergedEdition(ordered, primaryUri, coverImageUrl, description);

    await tx
      .update(editions)
      .set({
        identifiers: merged.identifiers,
        contributors: merged.contributors,
        coverImageUrl: merged.coverImageUrl,
        description: merged.description,
      })
      .where(eq(editions.uri, primaryUri));

    if (doomed.length > 0) {
      await tx.delete(editions).where(inArray(editions.uri, doomed));
    }

    return { merged, deleted: doomed };
  });
}
