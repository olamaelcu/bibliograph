import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';

export interface DumpStateFields {
  url?: string;
  filePath?: string;
  lastModified?: string | null;
  fileSize?: number | null;
  lastByteOffset?: number;
  lastKeyCursor?: string | null;
  lastNumericCursor?: number | null;
  totalProcessed?: number;
  complete?: boolean;
  startedAt?: string | null;
}

export class DumpState {
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly name: string,
  ) {}

  get(): typeof schema.backfillState.$inferSelect | null {
    return this.db
      .select()
      .from(schema.backfillState)
      .where(eq(schema.backfillState.name, this.name))
      .get() ?? null;
  }

  set(fields: DumpStateFields): void {
    const existing = this.get();
    const now = new Date().toISOString();
    const startedAt = fields.startedAt ?? existing?.startedAt ?? null;
    const totalProcessed = fields.totalProcessed ?? existing?.totalProcessed ?? 0;

    const values = {
      name: this.name,
      url: fields.url ?? existing?.url ?? '',
      filePath: fields.filePath ?? existing?.filePath ?? '',
      lastModified: fields.lastModified ?? existing?.lastModified ?? null,
      fileSize: fields.fileSize ?? existing?.fileSize ?? null,
      lastByteOffset: fields.lastByteOffset ?? existing?.lastByteOffset ?? 0,
      lastKeyCursor: fields.lastKeyCursor ?? existing?.lastKeyCursor ?? null,
      lastNumericCursor: fields.lastNumericCursor ?? existing?.lastNumericCursor ?? null,
      totalProcessed,
      complete: fields.complete ?? existing?.complete ?? false,
      startedAt,
      updatedAt: now,
    };

    this.db
      .insert(schema.backfillState)
      .values(values)
      .onConflictDoUpdate({
        target: schema.backfillState.name,
        set: {
          url: values.url,
          filePath: values.filePath,
          lastModified: values.lastModified,
          fileSize: values.fileSize,
          lastByteOffset: values.lastByteOffset,
          lastKeyCursor: values.lastKeyCursor,
          lastNumericCursor: values.lastNumericCursor,
          totalProcessed: values.totalProcessed,
          complete: values.complete,
          startedAt: values.startedAt,
          updatedAt: values.updatedAt,
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
