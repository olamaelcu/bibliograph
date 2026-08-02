import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createApp } from './app.js';
import { db } from './db/connection.js';
import * as tableSchema from './db/schema.js';
import { setupFts, setupIdentifiersView, bootstrapLibrarian } from './db/init.js';
import { logger } from './logger.js';
import { startTapChannel, stopTapChannel, trackRepos } from './tap.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main(): Promise<void> {
  logger.info('running database migrations');
  migrate(db, { migrationsFolder: './drizzle' });
  setupFts();
  setupIdentifiersView();
  bootstrapLibrarian();
  logger.info('migrations complete');

  const app = createApp();

  const safeFetch: typeof app.fetch = async (req: Request, ...args) => {
    try {
      return await app.fetch(req, ...args);
    } catch (err) {
      logger.fatal({ err }, 'uncaught error in app.fetch');
      return new Response(JSON.stringify({ error: 'InternalServerError', message: 'An unexpected error occurred' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  };

  serve({ fetch: safeFetch, port: PORT });
  logger.info({ port: PORT, serviceDid: process.env.ATP_SERVICE_DID || 'did:web:localhost' }, 'HTTP server running');

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    process.exit(1);
  });

  // Start Tap in background
  startTapChannel().catch((err) => {
    logger.error({ err }, 'Tap WebSocket error (reconnecting)');
  });

  // Load tracked repos after connection establishes
  setTimeout(async () => {
    try {
      const rows = db.select({ did: tableSchema.books.did })
        .from(tableSchema.books)
        .groupBy(tableSchema.books.did)
        .all();
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
