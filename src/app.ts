import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { requestTracing } from './middleware.js';
import { didDocumentHandler, getServiceDid } from './did.js';
import { lexiconsStatic } from './lexicons.js';
import { logger } from './logger.js';
import { db } from './db/connection.js';
import { BlobStore, blobStoreConfigFromEnv } from './storage/store.js';
import { registerBlobProxy } from './storage/blob-proxy.js';
import { createXrpcRouter } from './xrpc/router.js';
import { createHash } from 'node:crypto';
import { loadLexiconSchema, LexiconNotFound } from './lexicon-resolve.js';
import { dpopNonceMiddleware } from './oauth/nonce.js';
import { renderPage } from './pages/render.js';
import { catalogRecordNsids, lexiconEndpoints, procedureCount, queryCount, recordLexicons } from './lexicon-catalog.js';
import type { ViewContext } from './lex/collections.js';

export function createApp(): Hono {
	const app = new Hono();

	app.use('*', cors());
	app.use('*', requestTracing);
	app.use('*', dpopNonceMiddleware);

	const viewCtx: ViewContext = {
		serviceDid: getServiceDid(),
	};
	const xrpcRouter = createXrpcRouter(db, viewCtx);

	// Serve catalog blobs (covers/portraits) through the app. The BlobStore falls
	// back to memory when s3 is unconfigured, so registration only matters once a
	// real store is opted into; guard to keep the dev boot path lean.
	if (process.env.BLOB_STORE_SCHEME === 's3' || process.env.AWS_BUCKET) {
		const blobStore = new BlobStore(db, blobStoreConfigFromEnv());
		registerBlobProxy(app, db, blobStore);
	}

	const webAwesomeRoot = dirname(
		createRequire(import.meta.url).resolve('@awesome.me/webawesome/package.json'),
	);

	app.use(
		'/webawesome/*',
		serveStatic({
			root: webAwesomeRoot,
			// serveStatic joins the full URL path onto root; strip the mount prefix.
			rewriteRequestPath: (path) => path.replace(/^\/webawesome/, ''),
		}),
	);
	app.get('/', (ctx) =>
		ctx.html(
			renderPage('home', {
				title: 'Overview',
				description: 'Bibliograph AT Protocol AppView: procedures and queries served by the net.olamaelcu.livtet.biblio lexicon.',
				queryCount,
				procedureCount,
			}),
		),
	);
	app.get('/queries', (ctx) =>
		ctx.html(
			renderPage('queries', {
				title: 'Queries',
				description: 'Read-only queries served by the Bibliograph AppView.',
				endpoints: lexiconEndpoints.filter((e) => e.type === 'query'),
			}),
		),
	);
	app.get('/procedures', (ctx) =>
		ctx.html(
			renderPage('procedures', {
				title: 'Procedures',
				description: 'Bibliograph is a read-only AppView and serves no mutating procedures.',
				endpoints: lexiconEndpoints.filter((e) => e.type === 'procedure'),
			}),
		),
	);
	app.get('/records', (ctx) =>
		ctx.html(
			renderPage('records', {
				title: 'Records',
				description: 'Record types indexed from the Jetstream firehose, mirroring the catalog and user-owned records.',
				catalog: recordLexicons.filter((r) => catalogRecordNsids.has(r.id)),
				users: recordLexicons.filter((r) => !catalogRecordNsids.has(r.id)),
			}),
		),
	);
	app.get('/search', (ctx) =>
		ctx.html(
			renderPage('search', {
				title: 'Search',
				description: 'Search the Bibliograph catalog for books and covers.',
			}),
		),
	);
	app.get('/health', healthCheck);
	app.get('/.well-known/did.json', didDocumentHandler);
	app.get('/.well-known/atproto-did', serveAtprotoDid);

	const NSID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+(\.[a-z][a-z0-9-]*)$/;

	app.get('/lexicon/:nsid', async (ctx) => {
		const nsid = ctx.req.param('nsid');
		if (!NSID_RE.test(nsid)) {
			return ctx.json({ error: 'InvalidNsid', message: 'Invalid NSID format' }, 400);
		}
		try {
			const { json, bytes } = loadLexiconSchema(nsid);
			const etag = `W/"${createHash('sha256').update(bytes).digest('base64url')}"`;
			ctx.header('Cache-Control', 'public, max-age=300, must-revalidate');
			ctx.header('ETag', etag);
			return ctx.json(json);
		} catch (err) {
			if (err instanceof LexiconNotFound) {
				return ctx.json({ error: 'LexiconNotFound', message: err.message }, 404);
			}
			throw err;
		}
	});
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

function serveAtprotoDid(ctx: Context) {
	return ctx.text(getServiceDid(), 200, { 'content-type': 'text/plain; charset=utf-8' });
}

function handleServerError(err: unknown, ctx: Context) {
	logger.error({ err }, 'unhandled error');
	if (typeof err === 'object' && err !== null && 'status' in err) {
		const e = err as unknown as { status: number; error: string; message: string; };
		return ctx.json({ error: e.error || 'UnexpectedError', message: e.message || 'An error occurred' }, e.status as never);
	}
	return ctx.json({ error: 'InternalServerError', message: 'An unexpected error occurred' }, 500);
}
