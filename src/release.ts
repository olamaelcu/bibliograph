#!/usr/bin/env node
// Dokku release task — runs database migrations before web process starts.

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './db/connection.js';
import { logger } from './logger.js';
import { setupFts } from './db/init.js';

try {
  logger.info('release: running database migrations');

  try {
    migrate(db, { migrationsFolder: './drizzle' });
  } catch (err) {
    const msg = (err as Error).message;
    // Transition from old snake_case schema: drop and retry
    if (msg.includes('already exists') || msg.includes('no such column')) {
      logger.warn({ err }, 'stale schema detected, recreating database');
      db.run('DROP TABLE IF EXISTS books');
      db.run('DROP TABLE IF EXISTS claims');
      db.run('DROP TABLE IF EXISTS reviews');
      db.run('DROP TABLE IF EXISTS reading_statuses');
      db.run('DROP TABLE IF EXISTS book_labels');
      migrate(db, { migrationsFolder: './drizzle' });
      logger.info('release: recreated from fresh schema');
    } else {
      throw err;
    }
  }

  logger.info('release: migrations applied successfully');
  setupFts();
  logger.info('release: FTS5 setup complete');
} catch (err) {
  logger.fatal({ err }, 'release: migration failed');
  process.exit(1);
}
