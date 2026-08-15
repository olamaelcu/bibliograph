import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createApp } from './app.js';
import { db, sqliteHandle } from './db/connection.js';
import { logger } from './logger.js';
import { createJetstreamIngestor } from './jetstream/ingest.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main(): Promise<void> {
  try {
    migrate(db, { migrationsFolder: 'drizzle' });
    logger.info('migrations applied');
  } catch (err) {
    logger.fatal({ err }, 'migrations failed');
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

  const walCheckpointInterval = setInterval(() => {
    try {
      const result = sqliteHandle.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number; checkpointed: number }>;
      const frame = result[0];
      if (frame && frame.checkpointed > 0) {
        logger.info({ busy: frame.busy, log: frame.log, checkpointed: frame.checkpointed }, 'wal_checkpoint(TRUNCATE)');
      }
    } catch (err) {
      logger.warn({ err }, 'wal_checkpoint failed');
    }
  }, 30_000);
  walCheckpointInterval.unref();

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
    clearInterval(walCheckpointInterval);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
