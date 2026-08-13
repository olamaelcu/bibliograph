import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requestTracing } from './middleware.js';
import { logger } from './logger.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', cors());
  app.use('*', requestTracing);

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', version: '0.0.1' }));

  // Error handler
  app.onError((err, c) => {
    logger.error({ err }, 'unhandled error');
    if (typeof err === 'object' && err !== null && 'status' in err) {
      const e = err as unknown as { status: number; error: string; message: string };
      return c.json({ error: e.error || 'UnexpectedError', message: e.message || 'An error occurred' }, e.status as never);
    }
    return c.json({ error: 'InternalServerError', message: 'An unexpected error occurred' }, 500);
  });

  return app;
}
