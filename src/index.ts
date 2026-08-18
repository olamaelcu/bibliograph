import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createApp } from './app.js';
import { db, closeDb } from './db/connection.js';
import { logger } from './logger.js';
import { createJetstreamIngestor } from './jetstream/ingest.js';
import { assertNoDrift } from './db/schema-check.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main(): Promise<void> {
  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
    logger.info('migrations applied');
  } catch (err) {
    logger.fatal({ err }, 'migrations failed');
    process.exit(1);
  }

  try {
    await assertNoDrift(db);
  } catch (err) {
    logger.fatal({ err }, 'schema drift detected');
    process.exit(1);
  }

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
  logger.info({ port: PORT }, 'HTTP server running');

  const jetstream = process.env.JETSTREAM_DISABLE === 'true' ? undefined : createJetstreamIngestor(db);
  try {
    jetstream?.start();
  } catch (err) {
    logger.error({ err }, 'jetstream: failed to start, continuing without live ingest');
  }

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    process.exit(1);
  });

  const shutdown = async () => {
    logger.info('shutting down...');
    jetstream?.stop();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
