import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';

export interface BookhiveStateRow {
  catalogDid: string;
  lastRkey: string | null;
  lastModified: string | null;
  totalProcessed: number;
  complete: boolean;
  startedAt: string;
  updatedAt: string;
}

export interface BookhiveStateFields {
  catalogDid?: string;
  lastRkey?: string | null;
  lastModified?: string | null;
  totalProcessed?: number;
  complete?: boolean;
}

export class BookhiveCatalogState {
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly name: string,
  ) {}

  get(): BookhiveStateRow | null {
    const row = this.db
      .select()
      .from(schema.backfillState)
      .where(eq(schema.backfillState.name, this.name))
      .get();
    if (!row) return null;
    return {
      catalogDid: row.url,
      lastRkey: row.lastKeyCursor,
      lastModified: row.lastModified,
      totalProcessed: row.totalProcessed,
      complete: row.complete,
      startedAt: row.startedAt ?? new Date().toISOString(),
      updatedAt: row.updatedAt,
    };
  }

  set(fields: BookhiveStateFields): void {
    const existing = this.get();
    const now = new Date().toISOString();
    const startedAt = existing?.startedAt ?? now;

    this.db
      .insert(schema.backfillState)
      .values({
        name: this.name,
        url: fields.catalogDid ?? existing?.catalogDid ?? '',
        filePath: '',
        lastModified: fields.lastModified ?? existing?.lastModified ?? null,
        fileSize: 0,
        lastByteOffset: fields.totalProcessed ?? existing?.totalProcessed ?? 0,
        lastKeyCursor: fields.lastRkey ?? existing?.lastRkey ?? null,
        lastNumericCursor: null,
        totalProcessed: fields.totalProcessed ?? existing?.totalProcessed ?? 0,
        complete: fields.complete ?? existing?.complete ?? false,
        startedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.backfillState.name,
        set: {
          url: fields.catalogDid ?? existing?.catalogDid ?? '',
          lastModified: fields.lastModified ?? existing?.lastModified ?? null,
          lastByteOffset: fields.totalProcessed ?? existing?.totalProcessed ?? 0,
          lastKeyCursor: fields.lastRkey ?? existing?.lastRkey ?? null,
          totalProcessed: fields.totalProcessed ?? existing?.totalProcessed ?? 0,
          complete: fields.complete ?? existing?.complete ?? false,
          startedAt,
          updatedAt: now,
        },
      })
      .run();
  }

  markComplete(): void {
    this.set({ complete: true });
  }

  clear(): void {
    this.db
      .delete(schema.backfillState)
      .where(eq(schema.backfillState.name, this.name))
      .run();
  }
}
