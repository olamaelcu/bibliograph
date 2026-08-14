import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

describe('migrate', () => {
  it('applies all migrations and leaves a consistent journal', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'drizzle' });

    const journal = sqlite
      .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY id')
      .all() as Array<{ hash: string; created_at: number }>;

    const journalMeta = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: Array<{ tag: string }> };

    // One row per committed migration file.
    expect(journal.length).toBeGreaterThanOrEqual(3);
    expect(journal.length).toBe(journalMeta.entries.length);
    expect(journalMeta.entries.map((e) => e.tag)).toContain('0002_perfect_charles_xavier');

    // A renamed table exists with expected columns.
    const cols = sqlite
      .prepare("SELECT name FROM pragma_table_info('contributors') WHERE name = 'name'")
      .all() as Array<{ name: string }>;
    expect(cols).toHaveLength(1);
    expect(cols[0].name).toBe('name');
    sqlite.close();
  });
});
