import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { backfillState } from '../db/schema.js';

export interface DumpStateFields {
  url?: string;
  filePath?: string;
  lastModified?: string | null;
  fileSize?: number | null;
  /** Informational only; not used as a seek target (gzip dumps are not randomly seekable). */
  lastByteOffset?: number;
  lastKeyCursor?: string | null;
  totalProcessed?: number;
  complete?: boolean;
}

export class DumpState {
  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly name: string,
  ) {}

  get(): (typeof backfillState.$inferSelect) | null {
    return this.db.select().from(backfillState).where(eq(backfillState.name, this.name)).get() ?? null;
  }

  set(fields: DumpStateFields): void {
    const existing = this.get();
    const now = Math.floor(Date.now() / 1000);
    const values = {
      name: this.name,
      url: fields.url ?? existing?.url ?? null,
      filePath: fields.filePath ?? existing?.filePath ?? null,
      lastModified: fields.lastModified ?? existing?.lastModified ?? null,
      fileSize: fields.fileSize ?? existing?.fileSize ?? null,
      lastByteOffset: fields.lastByteOffset ?? existing?.lastByteOffset ?? 0,
      cursor: fields.lastKeyCursor ?? existing?.cursor ?? null,
      totalProcessed: fields.totalProcessed ?? existing?.totalProcessed ?? 0,
      complete: fields.complete ? 1 : (existing?.complete ?? 0),
      updatedAt: now,
    };
    this.db
      .insert(backfillState)
      .values(values)
      .onConflictDoUpdate({
        target: backfillState.name,
        set: values,
      })
      .run();
  }

  markComplete(): void {
    this.set({ complete: true });
  }

  clear(): void {
    this.db.delete(backfillState).where(eq(backfillState.name, this.name)).run();
  }
}
