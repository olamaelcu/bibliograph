#!/usr/bin/env node
// Dokku release task — runs database migrations before web process starts.

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './db/connection.js';
import { logger } from './logger.js';
import { setupFts } from './db/init.js';

try {
  logger.info('release: running database migrations');
  migrate(db, { migrationsFolder: './drizzle' });
  logger.info('release: migrations applied successfully');
  setupFts();
  logger.info('release: FTS5 setup complete');
} catch (err) {
  logger.fatal({ err }, 'release: migration failed');
  process.exit(1);
}
