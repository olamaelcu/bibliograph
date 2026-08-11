import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sql } from 'drizzle-orm';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath } from 'node:url';
import { requestTracing } from './middleware.js';
import { HomePage } from './views/home.js';
import { FeedsPage } from './views/feeds.js';
import { upgradeWebSocket } from '@hono/node-server';
import { createSubscribeLabelsEvents } from './labeler-service.js';
import { getBook, getBooks, getReviews, getReview, getUserStatus, searchBooksHandler, listBooksHandler, getClaims, getLabelerLabels, getShelves, getShelf, getShelfItems } from './api/get-book.js';
import { getFeed } from './api/get-feed.js';
import { createBook, createReview, createStatus, createClaim, verifyClaim, appointLibrarian, revokeLibrarian, createShelf, addToShelf, removeFromShelf } from './api/create-book.js';
import { createContributor, updateContributor, createContributorType } from './api/contributor.js';
import { listContributors, searchContributors, listContributorTypes } from './api/get-contributor.js';
import { serveLexicon, serveLexiconHashes } from './lexicons/serve.js';
import { getServiceDid, buildDidDocument } from './did.js';
import { db, schema } from './db/connection.js';
import { logger } from './logger.js';
import { serveCover } from './api/cover.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', cors());
  app.use('*', requestTracing);

  if (process.env.NODE_ENV === 'production') {
    app.use('/static/*', serveStatic({ root: fileURLToPath(new URL('../', import.meta.url)) }));
  }

  // Root route — endpoint reference rendered with Web Awesome components
  app.get('/', (c) => {
    const host = new URL(c.req.url).host;
    const queries = [
      'get',
      'getAll',
      'review.getAll',
      'review.get',
      'getUserStatus',
      'searchBooks',
      'listBooks',
      'getClaims',
      'getLabelerLabels',
      'getShelves',
      'getShelf',
      'getShelfItems',
      'getFeed',
      'contributor.list',
      'contributor.search',
      'contributor.listTypes',
    ];
    const procedures = [
      'createBook',
      'review.create',
      'createStatus',
      'createClaim',
      'verifyClaim',
      'appointLibrarian',
      'revokeLibrarian',
      'createShelf',
      'addToShelf',
      'removeFromShelf',
      'contributor.create',
      'contributor.update',
      'contributor.createType',
    ];

    return c.html(HomePage({ host, queries, procedures }));
  });

  // Feeds page — live view of the feed generator buckets
  app.get('/feeds', (c) => {
    const host = new URL(c.req.url).host;
    return c.html(FeedsPage({ host }));
  });

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', version: '0.0.1' }));

  // DID document for did:web resolution of this labeler service
  app.get('/.well-known/did.json', (c) => {
    const did = getServiceDid();
    const host = c.req.header('x-forwarded-host') || c.req.header('host') || did.replace(/^did:web:/, '');
    const proto = c.req.header('x-forwarded-proto') ?? (c.req.url.startsWith('https') ? 'https' : 'http');
    return c.json(buildDidDocument(did, `${proto}://${host}`));
  });

  // Lexicon serving endpoints for remote validation
  app.get('/lexicon/:nsid', serveLexicon);
  app.get('/lexicon-hashes.json', serveLexiconHashes);

  // Cover image proxy — serves transcoded JPG/AVIF variants from OpenDAL.
  // Path: /covers/{collection}/{rkey}-{size}.{ext} — parsed inside serveCover.
  app.get('/covers/*', serveCover);

  // Query endpoints (GET /xrpc/...)
  app.get('/xrpc/community.lexicon.book.get', getBook);
  app.get('/xrpc/community.lexicon.book.getAll', getBooks);
  app.get('/xrpc/community.lexicon.book.review.getAll', getReviews);
  app.get('/xrpc/community.lexicon.book.review.get', getReview);
  app.get('/xrpc/community.lexicon.book.getUserStatus', getUserStatus);
  app.get('/xrpc/community.lexicon.book.searchBooks', searchBooksHandler);
  app.get('/xrpc/community.lexicon.book.listBooks', listBooksHandler);
  app.get('/xrpc/community.lexicon.book.getClaims', getClaims);
  app.get('/xrpc/community.lexicon.book.getLabelerLabels', getLabelerLabels);
  app.get(
    '/xrpc/com.atproto.label.subscribeLabels',
    upgradeWebSocket((c) => {
      const cursor = c.req.query('cursor');
      return createSubscribeLabelsEvents()({ params: cursor !== undefined ? { cursor } : {} });
    }),
  );
  app.get('/xrpc/community.lexicon.book.getShelves', getShelves);
  app.get('/xrpc/community.lexicon.book.getShelf', getShelf);
  app.get('/xrpc/community.lexicon.book.getShelfItems', getShelfItems);
  app.get('/xrpc/community.lexicon.book.getFeed', getFeed);
  app.get('/xrpc/community.lexicon.book.contributor.list', listContributors);
  app.get('/xrpc/community.lexicon.book.contributor.search', searchContributors);
  app.get('/xrpc/community.lexicon.book.contributor.listTypes', listContributorTypes);

  // Procedure endpoints (POST /xrpc/...)
  app.post('/xrpc/community.lexicon.book.createBook', createBook);
  app.post('/xrpc/community.lexicon.book.review.create', createReview);
  app.post('/xrpc/community.lexicon.book.createStatus', createStatus);
  app.post('/xrpc/community.lexicon.book.createClaim', createClaim);
  app.post('/xrpc/community.lexicon.book.verifyClaim', verifyClaim);
  app.post('/xrpc/community.lexicon.book.appointLibrarian', appointLibrarian);
  app.post('/xrpc/community.lexicon.book.revokeLibrarian', revokeLibrarian);
  app.post('/xrpc/community.lexicon.book.createShelf', createShelf);
  app.post('/xrpc/community.lexicon.book.addToShelf', addToShelf);
  app.post('/xrpc/community.lexicon.book.removeFromShelf', removeFromShelf);
  app.post('/xrpc/community.lexicon.book.contributor.create', createContributor);
  app.post('/xrpc/community.lexicon.book.contributor.update', updateContributor);
  app.post('/xrpc/community.lexicon.book.contributor.createType', createContributorType);

  // Live counts SSE endpoint
  app.get('/api/live-counts', async (c) => {
    let closed = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream({
      async start(controller) {
        const send = async () => {
          if (closed) return;
          try {
            const bookCount = db.select({ count: sql<number>`count(*)` }).from(schema.books).get();
            const statusCount = db.select({ count: sql<number>`count(*)` }).from(schema.readingStatuses).get();
            const payload = JSON.stringify({
              books: bookCount?.count ?? 0,
              statuses: statusCount?.count ?? 0,
            });
            controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
          } catch {
            // silently skip failed queries
          }
        };

        await send();
        interval = setInterval(send, 5000);
      },
      cancel() {
        closed = true;
        if (interval) clearInterval(interval);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

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
