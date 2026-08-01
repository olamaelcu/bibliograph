import { v4 as uuid } from 'uuid';
import type { Context, Next } from 'hono';
import type pino from 'pino';
import { logger } from './logger.js';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    log: pino.Logger;
  }
}

export async function requestTracing(c: Context, next: Next): Promise<void> {
  const requestId = c.req.header('X-Request-Id') || uuid();
  const child = logger.child({ requestId });

  c.set('requestId', requestId);
  c.set('log', child as any);

  const start = Date.now();

  try {
    await next();
  } catch (err) {
    child.error({ err, method: c.req.method, path: c.req.path }, 'middleware error');
    throw err;
  }

  const duration = Date.now() - start;
  const status = c.res.status;

  child.info({
    method: c.req.method,
    path: c.req.path,
    status,
    duration: `${duration}ms`,
  }, `${c.req.method} ${c.req.path} ${status} ${duration}ms`);

  if (!c.res.headers.has('X-Request-Id')) {
    c.res.headers.set('X-Request-Id', requestId);
  }
}
