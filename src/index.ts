import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { runMigrations } from './db/init.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main(): Promise<void> {
  logger.info('Running migrations...');
  await runMigrations();
  logger.info('Migrations complete.');

  const app = createApp();
  logger.info({ port: PORT }, 'starting bibliograph AppView');

  serve({
    fetch: app.fetch,
    port: PORT,
  });

  logger.info({ port: PORT }, `server running at http://localhost:${PORT}`);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
