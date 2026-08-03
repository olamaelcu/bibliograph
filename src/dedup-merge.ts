import { eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema.js';
import { analyzeDuplicates, updateBookHash } from './dedup-detection.js';
import { logger } from './logger.js';

export interface MergeResult {
  merged: number;
  skipped: number;
  deleted: number;
  errors: number;
  details: MergeDetail[];
}

export interface MergeDetail {
  kept: string;
  removed: string[];
  title: string;
  author: string;
  identifiersMerged: number;
  error?: string;
}

function mergeIdentifiers(
  books: Array<{
    identifiers: Array<{ type: string; value: string }>;
  }>,
): Array<{ type: string; value: string }> {
  const seen = new Set<string>();
  const merged: Array<{ type: string; value: string }> = [];

  for (const book of books) {
    for (const id of book.identifiers) {
      if (!id.value) continue;
      const key = `${id.type}:${id.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ type: id.type, value: id.value });
      }
    }
  }

  return merged;
}

export async function mergeDuplicates(
  db: BetterSQLite3Database<typeof schema>,
  dryRun: boolean = false,
): Promise<MergeResult> {
  const analysis = await analyzeDuplicates(db, 1000);
  const result: MergeResult = {
    merged: 0,
    skipped: 0,
    deleted: 0,
    errors: 0,
    details: [],
  };

  for (const group of analysis.groups) {
    try {
      if (group.books.length < 2) {
        result.skipped++;
        continue;
      }

      const sorted = [...group.books].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const keeper = sorted[0];
      const toRemove = sorted.slice(1);

      const mergedIds = mergeIdentifiers(sorted);

      const detail: MergeDetail = {
        kept: keeper.uri,
        removed: toRemove.map((b) => b.uri),
        title: keeper.title,
        author: keeper.author,
        identifiersMerged: mergedIds.length,
      };

      if (dryRun) {
        result.details.push(detail);
        result.merged++;
        continue;
      }

      const bestIsbn = sorted.find((b) => b.isbn)?.isbn ?? keeper.isbn;
      const bestPageCount = sorted.find((b) => b.pageCount)?.pageCount ?? keeper.pageCount;
      const bestDescription = sorted.find((b) => b.description)?.description ?? keeper.description;
      const bestCoverUrl = sorted.find((b) => b.coverUrl)?.coverUrl ?? keeper.coverUrl;
      const bestPublishedDate =
        sorted.find((b) => b.publishedDate)?.publishedDate ?? keeper.publishedDate;

      await db
        .update(schema.books)
        .set({
          identifiers: mergedIds,
          isbn: bestIsbn,
          pageCount: bestPageCount ?? null,
          description: bestDescription ?? null,
          coverUrl: bestCoverUrl ?? null,
          publishedDate: bestPublishedDate ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.books.uri, keeper.uri))
        .run();

      await updateBookHash(db, keeper.uri);

      const removeUris = toRemove.filter((b) => b.uri !== keeper.uri).map((b) => b.uri);
      if (removeUris.length > 0) {
        await db
          .update(schema.readingStatuses)
          .set({ bookUri: keeper.uri })
          .where(inArray(schema.readingStatuses.bookUri, removeUris))
          .run();

        await db
          .update(schema.reviews)
          .set({ bookUri: keeper.uri })
          .where(inArray(schema.reviews.bookUri, removeUris))
          .run();

        await db
          .update(schema.shelfItems)
          .set({ bookUri: keeper.uri })
          .where(inArray(schema.shelfItems.bookUri, removeUris))
          .run();

        await db
          .update(schema.bookLabels)
          .set({ uri: keeper.uri })
          .where(inArray(schema.bookLabels.uri, removeUris))
          .run();

        await db
          .update(schema.labelEvents)
          .set({ uri: keeper.uri })
          .where(inArray(schema.labelEvents.uri, removeUris))
          .run();

        await db
          .update(schema.claims)
          .set({ bookUri: keeper.uri })
          .where(inArray(schema.claims.bookUri, removeUris))
          .run();

        for (const uri of removeUris) {
          try {
            await db.delete(schema.books).where(eq(schema.books.uri, uri)).run();
            result.deleted++;
          } catch (err) {
            logger.error({ err, uri, keeper: keeper.uri }, 'failed to delete duplicate book');
            detail.error = String(err);
            result.errors++;
          }
        }
      }

      result.details.push(detail);
      result.merged++;
    } catch (err) {
      logger.error({ err, group: group.hash, title: group.title }, 'failed to merge group');
      result.errors++;
    }
  }

  return result;
}
