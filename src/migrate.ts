#!/usr/bin/env node
// Run pending Drizzle migrations against the configured DB_PATH.
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqliteHandle } from './db/connection.js';
import { logger } from './logger.js';

try {
  migrate(db, { migrationsFolder: 'drizzle' });
  logger.info('migrations applied');
  sqliteHandle.close();
} catch (err) {
  logger.fatal({ err }, 'migrations failed');
  process.exit(1);
}
