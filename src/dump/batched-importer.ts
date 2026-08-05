import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BookData } from '../providers/interface.js';
import type { BackfillSummary } from '../backfill-import.js';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { computeDeduplicationHash } from '../dedup.js';
import { generateRkey } from '../rkey.js';
import { logger } from '../logger.js';
import { SERVICE_DID } from '../backfill-import.js';

export interface BatchedImporterOptions {
  batchSize?: number;
  onFlush?: () => void;
}

type Outcome = 'imported' | 'skipped' | 'failed';

export class BatchedImporter {
  private readonly batchSize: number;
  private readonly onFlush?: () => void;

  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    opts: BatchedImporterOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 500;
    this.onFlush = opts.onFlush;
  }

  async runAll(items: BookData[]): Promise<BackfillSummary> {
    const summary: BackfillSummary = { imported: 0, skipped: 0, notFound: 0, failed: 0 };
    const seen = new Set<string>();
    let buffer: BookData[] = [];

    for (const item of items) {
      buffer.push(item);
      if (buffer.length >= this.batchSize) {
        const flushed = this.flush(buffer, seen);
        this.mergeSummary(summary, flushed);
        buffer = [];
        this.onFlush?.();
      }
    }
    if (buffer.length > 0) {
      const flushed = this.flush(buffer, seen);
      this.mergeSummary(summary, flushed);
      this.onFlush?.();
    }
    return summary;
  }

  private flush(items: BookData[], seen: Set<string>): BackfillSummary {
    const summary: BackfillSummary = { imported: 0, skipped: 0, notFound: 0, failed: 0 };

    try {
      this.db.transaction(() => {
        for (const item of items) {
          const outcome = this.insertOneSync(item, seen);
          if (outcome === 'imported') summary.imported += 1;
          else if (outcome === 'skipped') summary.skipped += 1;
          else summary.failed += 1;
        }
      });
    } catch (err) {
      logger.error({ err, count: items.length }, 'batched importer: whole batch failed');
    }
    return summary;
  }

  private insertOneSync(data: BookData, seen: Set<string>): Outcome {
    const canonical = data.isbn13 || data.isbn10 || '';
    const idKey = data.identifiers.openlibrary ?? '';
    const dedupKey = idKey || canonical;
    if (dedupKey) {
      if (seen.has(dedupKey)) return 'skipped';
      seen.add(dedupKey);
    }

    const dhash = computeDeduplicationHash(data.title, data.author, data.publishedDate);
    if (dhash) {
      const hashMatch = this.db
        .select({ uri: schema.books.uri })
        .from(schema.books)
        .where(eq(schema.books.deduplicationHash, dhash))
        .get();
      if (hashMatch) return 'skipped';
    }

    if (canonical) {
      const existing = this.db
        .select({ uri: schema.books.uri })
        .from(schema.books)
        .where(eq(schema.books.isbn, canonical))
        .get();
      if (existing) return 'skipped';
    }

    if (!data.title || !data.author) {
      return 'failed';
    }

    const now = new Date().toISOString();
    const uri = `at://${SERVICE_DID}/community.lexicon.book.book/${generateRkey()}`;
    try {
      this.db
        .insert(schema.books)
        .values({
          uri,
          did: SERVICE_DID,
          title: data.title,
          author: data.author,
          isbn: canonical,
          publishedDate: data.publishedDate,
          description: data.description,
          pageCount: data.pageCount,
          language: data.language,
          categories: data.categories || [],
          identifiers: Object.entries(data.identifiers).map(([type, value]) => ({ type, value })),
          coverUrl: data.coverUrl,
          deduplicationHash: dhash,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return 'imported';
    } catch (err) {
      logger.error({ err, uri }, 'batched importer: insert failed');
      return 'failed';
    }
  }

  private mergeSummary(into: BackfillSummary, from: BackfillSummary): void {
    into.imported += from.imported;
    into.skipped += from.skipped;
    into.notFound += from.notFound;
    into.failed += from.failed;
  }
}
