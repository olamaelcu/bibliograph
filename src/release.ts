#!/usr/bin/env node
// Dokku release task. Runs before the web process starts;
// will run database migrations.

import { logger } from './logger.js';

try {
  logger.info('release: no migrations to run');
} catch (err) {
  logger.fatal({ err }, 'release: failed');
  process.exit(1);
}
