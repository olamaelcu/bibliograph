import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./db/connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('./db/schema.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  (db as any).$sqlite = sqlite;
  return { db, schema };
});

import { db, schema } from './db/connection.js';
import { clearSqliteTables } from './test-utils/db.js';
import { isFeatureEnabled } from './features.js';

beforeEach(() => {
  clearSqliteTables((db as any).$sqlite);
});

describe('isFeatureEnabled', () => {
  it('returns false when the feature row is missing', () => {
    expect(isFeatureEnabled('feedGenerator')).toBe(false);
  });

  it('returns true when the feature is enabled', () => {
    db.insert(schema.features).values({ name: 'feedGenerator', enabled: 1 }).run();
    expect(isFeatureEnabled('feedGenerator')).toBe(true);
  });

  it('returns false when the feature is disabled', () => {
    db.insert(schema.features).values({ name: 'feedGenerator', enabled: 0 }).run();
    expect(isFeatureEnabled('feedGenerator')).toBe(false);
  });
});
