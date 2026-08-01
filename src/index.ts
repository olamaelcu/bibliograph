import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createApp } from './app.js';
import { db } from './db/connection.js';
import { setupFts, bootstrapLibrarian } from './db/init.js';
import { logger } from './logger.js';
import { startTapChannel, stopTapChannel, trackRepos } from './tap.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main(): Promise<void> {
  logger.info('running database migrations');
  migrate(db, { migrationsFolder: './drizzle' });
  setupFts();
  bootstrapLibrarian();
  logger.info('migrations complete');

  const app = createApp();
  serve({ fetch: app.fetch, port: PORT });
  logger.info({ port: PORT }, 'HTTP server running');

  // Start Tap in background
  startTapChannel().catch((err) => {
    logger.error({ err }, 'Tap WebSocket error (reconnecting)');
  });

  // Load tracked repos after connection establishes
  setTimeout(async () => {
    try {
      const rows = db.all('SELECT DISTINCT did FROM books') as { did: string }[];
      const dids = rows.map(r => r.did);
      if (dids.length > 0) await trackRepos(dids);
    } catch (err) {
      logger.error({ err }, 'failed to load initial repos');
    }
  }, 3000);

  const shutdown = async () => {
    logger.info('shutting down...');
    await stopTapChannel();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
