#!/usr/bin/env node
// Run pending Drizzle migrations against the configured DATABASE_URL.
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, closeDb } from './db/connection.js';
import { logger } from './logger.js';

try {
  await migrate(db, { migrationsFolder: 'drizzle' });
  logger.info('migrations applied');
  await closeDb();
} catch (err) {
  logger.fatal({ err }, 'migrations failed');
  process.exit(1);
}
