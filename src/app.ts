import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { requestTracing } from './middleware.js';
import { didDocumentHandler } from './did.js';
import { lexiconsStatic } from './lexicons.js';
import { logger } from './logger.js';
import { db } from './db/connection.js';
import { createXrpcRouter } from './xrpc/router.js';
import type { ViewContext } from './xrpc/views.js';

export function createApp(): Hono {
	const app = new Hono();

	app.use('*', cors());
	app.use('*', requestTracing);

	const viewCtx: ViewContext = {
		serviceDid: process.env.ATP_SERVICE_DID || `did:web:${defaultHost()}`,
	};
	const xrpcRouter = createXrpcRouter(db, viewCtx);

	app.get('/health', healthCheck);
	app.get('/.well-known/did.json', didDocumentHandler);
	app.use('/lexicons/*', lexiconsStatic);
	app.all('/xrpc/*', (ctx) => xrpcRouter.fetch(ctx.req.raw));
	app.onError(handleServerError);

	return app;
}

function defaultHost(): string {
	return process.env.ATP_SERVICE_HOST || 'localhost';
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
