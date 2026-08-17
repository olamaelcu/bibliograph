import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './test-utils/db.js';

describe('migrate', () => {
  it('applies all migrations and leaves a consistent journal', async () => {
    const { db } = await createTestDb();

    const result = await db.execute(
      sql`SELECT hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id`,
    );
    const journal = result.rows as Array<{ hash: string; created_at: string }>;

    const journalMeta = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: Array<{ tag: string }> };

    // One row per committed migration file.
    expect(journal.length).toBeGreaterThanOrEqual(1);
    expect(journal.length).toBe(journalMeta.entries.length);
    expect(journalMeta.entries[0].tag).toBe('0000_tidy_grey_gargoyle');

    // A renamed table exists with expected columns.
    const cols = await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'contributors' AND column_name = 'name'`,
    );
    expect(cols.rows).toHaveLength(1);
    expect((cols.rows[0] as { column_name: string }).column_name).toBe('name');
  });
});
