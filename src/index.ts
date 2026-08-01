import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { runMigrations } from './db/init.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main(): Promise<void> {
  console.log('Running migrations...');
  await runMigrations();
  console.log('Migrations complete.');

  const app = createApp();
  console.log(`Bibliograph AppView starting on port ${PORT}`);

  serve({
    fetch: app.fetch,
    port: PORT,
  });

  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
