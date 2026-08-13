import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

const dbPath = resolve(process.env.DB_PATH || 'data/bibliograph.db');
const dataDir = dirname(dbPath);

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('journal_size_limit = 134217728');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 100');
// Cache ~800 MB of pages. The default 2 MB is far too small for the 3+ GB
// production database; with only 2 MB the page cache thrashes on every query
// and the event loop blocks on disk I/O. Negative values are interpreted as
// kibibytes by SQLite, so -200000 ≈ 200_000 * 1024 = ~200 MB pages cached.
// (200_000 KiB ≈ 195 MiB). On the 2 GB production host this leaves ~1.8 GB
// for the OS page cache and node heap.
sqlite.pragma('cache_size = -200000');

export const db = drizzle(sqlite, { schema });
export { schema };
export const sqliteHandle: BetterSqlite3Database = sqlite;

export interface WriteRetryOptions {
  maxWaitMs?: number;
}

/**
 * Run a DB write, retrying while the importer's batch transaction holds the
 * write lock. SQLite in WAL mode allows one writer at a time; when a backfill
 * is mid-batch the live app briefly hits SQLITE_BUSY. We wait (bounded) rather
 * than fail the request.
 */
export async function withWriteRetry<T>(
  fn: () => T,
  opts: WriteRetryOptions = {},
): Promise<T> {
  const maxWaitMs = opts.maxWaitMs ?? 3000;
  const start = Date.now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      if (!isBusyError(err) || Date.now() - start >= maxWaitMs) throw err;
      const backoff = Math.min(100 * 2 ** Math.min(attempt, 4), 250);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

export function isBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY|database is locked/.test(err.message);
}
