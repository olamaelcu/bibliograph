import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { backfillState } from '../db/schema.js';

type Database = NodePgDatabase<typeof schema>;

export interface DumpStateFields {
  url?: string;
  filePath?: string;
  lastModified?: string | null;
  fileSize?: number | null;
  /** Informational only; not used as a seek target (gzip dumps are not randomly seekable). */
  lastByteOffset?: number;
	lastKeyCursor?: string | null;
	totalProcessed?: number;
	totalRecords?: number;
  complete?: boolean;
  /** True when the last run stopped before completing (e.g. interrupted). */
  stopped?: boolean;
}

export class DumpState {
  constructor(
    private readonly db: Database,
    private readonly name: string,
  ) {}

  async get(): Promise<(typeof backfillState.$inferSelect) | null> {
    const rows = await this.db.select().from(backfillState).where(eq(backfillState.name, this.name));
    return rows[0] ?? null;
  }

  async set(fields: DumpStateFields): Promise<void> {
    const existing = await this.get();
    const now = Math.floor(Date.now() / 1000);
    const values = {
      name: this.name,
      url: fields.url ?? existing?.url ?? null,
      filePath: fields.filePath ?? existing?.filePath ?? null,
      lastModified: fields.lastModified ?? existing?.lastModified ?? null,
      fileSize: fields.fileSize ?? existing?.fileSize ?? null,
      // undefined means "keep", so an explicit null (clear) or 0 (reset) is honored.
      lastByteOffset: fields.lastByteOffset !== undefined ? fields.lastByteOffset : (existing?.lastByteOffset ?? 0),
      cursor: fields.lastKeyCursor !== undefined ? fields.lastKeyCursor : (existing?.cursor ?? null),
      totalProcessed: fields.totalProcessed ?? existing?.totalProcessed ?? 0,
      totalRecords: fields.totalRecords ?? existing?.totalRecords ?? null,
      complete: fields.complete ? 1 : (existing?.complete ?? 0),
      // undefined means "keep", so an explicit false (not stopped) or true is honored.
      stopped: fields.stopped !== undefined ? (fields.stopped ? 1 : 0) : (existing?.stopped ?? 0),
      updatedAt: now,
    };
    await this.db
      .insert(backfillState)
      .values(values)
      .onConflictDoUpdate({
        target: backfillState.name,
        set: values,
      });
  }

  async markComplete(): Promise<void> {
    await this.set({ complete: true, stopped: false });
  }

  async clear(): Promise<void> {
    await this.db.delete(backfillState).where(eq(backfillState.name, this.name));
  }
}
