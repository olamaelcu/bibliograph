#!/usr/bin/env node
// Dokku release task. Runs before the web process starts;
// applies pending database migrations.

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './db/connection.js';
import { logger } from './logger.js';

try {
  migrate(db, { migrationsFolder: 'drizzle' });
  logger.info('release: migrations applied');
} catch (err) {
  logger.fatal({ err }, 'release: migration failed');
  process.exit(1);
}
