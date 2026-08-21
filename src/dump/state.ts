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
    // Build the values object with only the columns we actually want to write.
    // The previous implementation included every column in the SET clause and
    // fell through to null when a field was not passed AND the existing row had
    // no value — which silently overwrote columns (e.g. total_records → null)
    // on every checkpoint. The fix: include a column only when the caller
    // passed it explicitly OR the existing row has a non-null value to keep.
    // An explicit null/0/false still clears the column.
    const values: Partial<typeof backfillState.$inferInsert> = { name: this.name, updatedAt: now };
    const keep = <T>(passed: T | undefined, current: T | undefined): T | undefined =>
      passed !== undefined ? passed : current;
    const setIfPresent = <K extends keyof typeof fields>(
      key: K,
      column: keyof typeof backfillState.$inferInsert,
      current: unknown,
    ): void => {
      if (fields[key] !== undefined) (values as Record<string, unknown>)[column as string] = fields[key];
      else if (current !== undefined && current !== null) (values as Record<string, unknown>)[column as string] = current;
    };
    setIfPresent('url', 'url', existing?.url);
    setIfPresent('filePath', 'filePath', existing?.filePath);
    setIfPresent('lastModified', 'lastModified', existing?.lastModified);
    setIfPresent('fileSize', 'fileSize', existing?.fileSize);
    // Numeric reset fields: caller can pass 0 to clear, undefined to keep
    // (falling through to the existing value).
    if (fields.lastByteOffset !== undefined) values.lastByteOffset = fields.lastByteOffset;
    else if (existing?.lastByteOffset != null) values.lastByteOffset = existing.lastByteOffset;
    if (fields.lastKeyCursor !== undefined) values.cursor = fields.lastKeyCursor;
    else if (existing?.cursor != null) values.cursor = existing.cursor;
    if (fields.totalProcessed !== undefined) values.totalProcessed = fields.totalProcessed;
    else if (existing?.totalProcessed != null) values.totalProcessed = existing.totalProcessed;
    if (fields.totalRecords !== undefined) values.totalRecords = fields.totalRecords;
    else if (existing?.totalRecords != null) values.totalRecords = existing.totalRecords;
    if (fields.complete !== undefined) values.complete = fields.complete ? 1 : 0;
    else if (existing?.complete != null) values.complete = existing.complete;
    if (fields.stopped !== undefined) values.stopped = fields.stopped ? 1 : 0;
    else if (existing?.stopped != null) values.stopped = existing.stopped;
    await this.db
      .insert(backfillState)
      .values(values as never)
      .onConflictDoUpdate({
        target: backfillState.name,
        set: values as never,
      });
  }

  async markComplete(): Promise<void> {
    await this.set({ complete: true, stopped: false });
  }

  async clear(): Promise<void> {
    await this.db.delete(backfillState).where(eq(backfillState.name, this.name));
  }
}
