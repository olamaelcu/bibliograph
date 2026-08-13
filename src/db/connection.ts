import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

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

export const db = drizzle(sqlite);
export const sqliteHandle: BetterSqlite3Database = sqlite;
