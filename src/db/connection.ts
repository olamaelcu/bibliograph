import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

const dbPath = resolve(process.env.DB_PATH || 'data/bibliograph.db');
const dataDir = dirname(dbPath);

if (!existsSync(dataDir)) {
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    console.warn(`Could not create ${dataDir}, falling back to cwd`);
  }
}

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('cache_size = -20000');

export const db = drizzle(sqlite, { schema });
export { schema };
