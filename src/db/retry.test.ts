import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { withWriteRetry, isBusyError } from './connection.js';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 100');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  (db as any).$sqlite = sqlite;
  return { sqlite, db };
}

describe('withWriteRetry', () => {
  it('returns the value on first success', async () => {
    const result = await withWriteRetry(() => 42);
    expect(result).toBe(42);
  });

  it('retries on SQLITE_BUSY then succeeds', async () => {
    let calls = 0;
    const result = await withWriteRetry(() => {
      calls += 1;
      if (calls === 1) {
        const e = new Error('SQLITE_BUSY: database is locked');
        (e as any).code = 'SQLITE_BUSY';
        throw e;
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('gives up after maxWaitMs and rethrows the busy error', async () => {
    const err = new Error('SQLITE_BUSY: database is locked');
    (err as any).code = 'SQLITE_BUSY';
    const start = Date.now();
    await expect(
      withWriteRetry(() => {
        throw err;
      }, { maxWaitMs: 150 }),
    ).rejects.toThrow('SQLITE_BUSY');
    expect(Date.now() - start).toBeGreaterThanOrEqual(120);
  });

  it('does not retry non-busy errors', async () => {
    let calls = 0;
    await expect(
      withWriteRetry(() => {
        calls += 1;
        throw new Error('some other failure');
      }, { maxWaitMs: 100 }),
    ).rejects.toThrow('some other failure');
    expect(calls).toBe(1);
  });
});

describe('isBusyError', () => {
  it('matches SQLITE_BUSY and database is locked', () => {
    expect(isBusyError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
    expect(isBusyError(new Error('database is locked'))).toBe(true);
    expect(isBusyError(new Error('SQLITE_BUSY'))).toBe(true);
    expect(isBusyError(new Error('boom'))).toBe(false);
    expect(isBusyError(null)).toBe(false);
  });
});
