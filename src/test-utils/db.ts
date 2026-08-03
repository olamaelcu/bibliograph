import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema.js';

export type TestDb = {
  db: BetterSQLite3Database<typeof schema>;
  schema: typeof schema;
};

const ALL_TABLES = [
  schema.books,
  schema.claims,
  schema.reviews,
  schema.readingStatuses,
  schema.shelves,
  schema.shelfItems,
] as const;

export function clearAllTables(db: BetterSQLite3Database<typeof schema>): void {
  for (const t of ALL_TABLES) {
    db.delete(t).run();
  }
}

export function clearSqliteTables(sqlite: InstanceType<typeof import('better-sqlite3')>): void {
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .filter(t => !t.name.startsWith('sqlite_') && !t.name.startsWith('__drizzle'));
  for (const t of tables) {
    try { sqlite.prepare(`DELETE FROM "${t.name}"`).run(); } catch {}
  }
}

export function createTestDb(): TestDb {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  // Store the sqlite instance off the db object so we can close it
  (db as any).$sqlite = sqlite;

  return { db, schema };
}

export function seedBook(
  db: TestDb['db'],
  overrides: Partial<typeof schema.books.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  const uri = overrides.uri || `at://did:plc:test/community.lexicon.book.book/${Math.random().toString(36).slice(2, 15)}`;
  db.insert(schema.books).values({
    uri,
    did: 'did:plc:test',
    title: 'Test Book',
    author: 'Test Author',
    isbn: '9781234567890',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return uri;
}
