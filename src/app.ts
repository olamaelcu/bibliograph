import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { requestTracing } from './middleware.js';
import { logger } from './logger.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', cors());
  app.use('*', requestTracing);

  app.get('/health', healthCheck);
  app.onError(handleServerError);

  return app;
}

function healthCheck(ctx: Context) {
  return ctx.json({ status: 'ok', version: '0.0.1' });
}

function handleServerError(err: unknown, ctx: Context) {
  logger.error({ err }, 'unhandled error');
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const e = err as unknown as { status: number; error: string; message: string; };
    return ctx.json({ error: e.error || 'UnexpectedError', message: e.message || 'An error occurred' }, e.status as never);
  }
  return ctx.json({ error: 'InternalServerError', message: 'An unexpected error occurred' }, 500);
}
