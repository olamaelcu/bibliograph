import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema.js';

export type TestDb = {
  db: BetterSQLite3Database<typeof schema>;
  schema: typeof schema;
};

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
