import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('./tap.js', () => ({ trackRepos: vi.fn() }));

import { db } from './db/connection.js';
import { trackRepos } from './tap.js';
import { collectKnownDids, backfillDid } from './backfill.js';
import * as _s from './db/schema.js';
import { clearAllTables } from './test-utils/db.js';

describe('collectKnownDids', () => {
  beforeEach(() => {
    clearAllTables(db);
  });

  it('returns distinct DIDs across all tables', () => {
    const now = new Date().toISOString();
    db.insert(_s.books).values({ uri: 'at://did:plc:a/book/1', did: 'did:plc:a', title: 'T', author: 'A', status: 'active', createdAt: now, updatedAt: now }).run();
    db.insert(_s.books).values({ uri: 'at://did:plc:b/book/1', did: 'did:plc:b', title: 'T', author: 'A', status: 'active', createdAt: now, updatedAt: now }).run();
    db.insert(_s.books).values({ uri: 'at://did:plc:a/book/2', did: 'did:plc:a', title: 'T2', author: 'A', status: 'active', createdAt: now, updatedAt: now }).run();

    expect(collectKnownDids(db)).toEqual(expect.arrayContaining(['did:plc:a', 'did:plc:b']));
  });
});

describe('backfillDid', () => {
  beforeEach(() => {
    vi.mocked(trackRepos).mockClear();
    process.env.TAP_URL = 'http://localhost:2480';
  });

  afterEach(() => {
    delete process.env.TAP_URL;
  });

  it('tracks a valid DID', async () => {
    await backfillDid('did:plc:abc123');
    expect(trackRepos).toHaveBeenCalledWith(['did:plc:abc123']);
  });

  it('rejects a malformed DID', async () => {
    await expect(backfillDid('not-a-did')).rejects.toThrow(/invalid DID/i);
    expect(trackRepos).not.toHaveBeenCalled();
  });
});
