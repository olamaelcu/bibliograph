import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sql } from 'drizzle-orm';
import { requestTracing } from './middleware.js';
import { upgradeWebSocket } from '@hono/node-server';
import { createSubscribeLabelsEvents } from './labeler-service.js';
import { getBook, getBooks, getReviews, getReview, getUserStatus, searchBooksHandler, getClaims, getLabelerLabels, getShelves, getShelf, getShelfItems } from './api/get-book.js';
import { createBook, createReview, createStatus, createClaim, verifyClaim, appointLibrarian, revokeLibrarian, createShelf, addToShelf, removeFromShelf } from './api/create-book.js';
import { handleRecordEvent } from './indexer.js'; // kept for potential reuse
import { serveLexicon, serveLexiconHashes } from './lexicons/serve.js';
import { getServiceDid, buildDidDocument } from './did.js';
import { OpenLibraryProvider } from './providers/openlibrary.js';
import { db, schema } from './db/connection.js';
import { logger } from './logger.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', cors());
  app.use('*', requestTracing);

  // Root route
  app.get('/', (c) => {
    const host = new URL(c.req.url).host;
    const queries = [
      'getBook',
      'getBooks',
      'getReviews',
      'getReview',
      'getUserStatus',
      'searchBooks',
      'getClaims',
      'getLabelerLabels',
      'getShelves',
      'getShelf',
      'getShelfItems',
    ];
    const procedures = [
      'createBook',
      'createReview',
      'createStatus',
      'createClaim',
      'verifyClaim',
      'appointLibrarian',
      'revokeLibrarian',
      'createShelf',
      'addToShelf',
      'removeFromShelf',
    ];
    const prefix = 'community.lexicon.book';

    const queryRows = queries
      .map((q) => `<tr><td class="get">GET</td><td>/xrpc/${prefix}.${q}</td></tr>`)
      .join('\n');
    const procRows = procedures
      .map((p) => `<tr><td class="post">POST</td><td>/xrpc/${prefix}.${p}</td></tr>`)
      .join('\n');

    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Bibliograph</title>
  <style>
    body { font-family: monospace; background: #0a0a0a; color: #f0e6d3;
           display: flex; flex-direction: column; align-items: center;
           min-height: 100vh; margin: 0; padding: 2rem 0; }
    pre { font-size: 14px; line-height: 1.2; text-align: center; }
    h2 { color: #c4a86a; margin: 1.5rem 0 0.5rem; font-size: 13px; text-transform: uppercase; letter-spacing: 2px; }
    table { border-collapse: collapse; width: 600px; }
    td { padding: 3px 8px; font-size: 12px; }
    td:first-child { text-align: right; width: 40px; }
    td:last-child { color: #a09080; }
    .get { color: #6b9; font-weight: bold; }
    .post { color: #e8a; font-weight: bold; }
    .info { color: #8a7a5a; margin-top: 0.25rem; font-size: 12px; }
    .info a { color: #a09080; text-decoration: none; }
    .info a:hover { color: #c4a86a; }
    .divider { color: #444; margin: 0; font-size: 12px; }
    .other { color: #8a7a5a; margin-top: 0.5rem; font-size: 11px; }
    .other td { padding: 2px 8px; font-size: 11px; }
    .auth { color: #8a7a5a; margin-top: 1.5rem; font-size: 10px; line-height: 1.6; width: 600px; }
    .counts { display: flex; gap: 3rem; margin: 1rem 0; }
    .count-box { text-align: center; }
    .count-num { font-size: 28px; color: #c4a86a; font-weight: bold; line-height: 1.2; }
    .count-label { font-size: 10px; color: #8a7a5a; text-transform: uppercase; letter-spacing: 1px; }
    .sse-status { font-size: 9px; color: #555; margin-top: 0.5rem; }
    .sse-status.live { color: #6b9; }
  </style>
</head>
<body>
<pre>
    _________________________
   /                         \\
  |    ┌─────────────────┐    |
  |    │  BIBLIOGRAPH    │    |
  |    │  community.lexi │    |
  |    │  con.book       │    |
  |    └─────────────────┘    |
  |                           |
  |   .-------------------.   |
  |   |    ~ book ~       |   |
  |   |    ~ review ~     |   |
  |   |    ~ claim ~      |   |
  |   '-------------------'   |
  |                           |
   \\_________________________/
</pre>

<div class="counts">
  <div class="count-box">
    <div class="count-num" id="book-count">&mdash;</div>
    <div class="count-label">Books</div>
  </div>
  <div class="count-box">
    <div class="count-num" id="status-count">&mdash;</div>
    <div class="count-label">Statuses</div>
  </div>
</div>
<div class="sse-status" id="sse-status">connecting&hellip;</div>

<script>
(function() {
  const bookEl = document.getElementById('book-count');
  const statusEl = document.getElementById('status-count');
  const sseStatus = document.getElementById('sse-status');

  function connect() {
    sseStatus.className = 'sse-status';
    sseStatus.textContent = 'connecting\\u2026';
    const es = new EventSource('/api/live-counts');
    es.onmessage = function(e) {
      const data = JSON.parse(e.data);
      bookEl.textContent = data.books.toLocaleString();
      statusEl.textContent = data.statuses.toLocaleString();
      sseStatus.className = 'sse-status live';
      sseStatus.textContent = 'live';
    };
    es.onerror = function() {
      sseStatus.className = 'sse-status';
      sseStatus.textContent = 'reconnecting\\u2026';
      es.close();
      setTimeout(connect, 3000);
    };
  }
  connect();
})();
</script>

<h2>${queries.length} Queries</h2>
<details>
  <table>${queryRows}</table>
</details>

<h2>${procedures.length} Procedures</h2>
<details>
  <table>${procRows}</table>
</details>

<p class="divider">──────────────────────</p>
<table class="other">
<tr><td class="post">POST</td><td>/tap/event <span style="color:#666">— webhook fallback</span></td></tr>
<tr><td class="get">GET</td><td>/api/lookup/book</td></tr>
<tr><td class="get">GET</td><td>/health</td></tr>
</table>

<p class="auth">Authenticate with ATProto service JWTs:<br>
<span style="color:#666">Authorization: Bearer &lt;jwt&gt;</span><br>
<span style="color:#555">iss: your DID &middot; aud: did:web:biblio.livtet.olamaelcu.net#atproto_pds &middot; lxm: &lt;endpoint-nsid&gt;</span></p>

<div class="info">Bibliograph &mdash; ${host}</div>
<div class="info"><a href="https://github.com/olamaelcu/bibliograph">github.com/olamaelcu/bibliograph</a></div>
</body>
</html>`);
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

  // Query endpoints (GET /xrpc/...)
  app.get('/xrpc/community.lexicon.book.getBook', getBook);
  app.get('/xrpc/community.lexicon.book.getBooks', getBooks);
  app.get('/xrpc/community.lexicon.book.getReviews', getReviews);
  app.get('/xrpc/community.lexicon.book.getReview', getReview);
  app.get('/xrpc/community.lexicon.book.getUserStatus', getUserStatus);
  app.get('/xrpc/community.lexicon.book.searchBooks', searchBooksHandler);
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

  // Procedure endpoints (POST /xrpc/...)
  app.post('/xrpc/community.lexicon.book.createBook', createBook);
  app.post('/xrpc/community.lexicon.book.createReview', createReview);
  app.post('/xrpc/community.lexicon.book.createStatus', createStatus);
  app.post('/xrpc/community.lexicon.book.createClaim', createClaim);
  app.post('/xrpc/community.lexicon.book.verifyClaim', verifyClaim);
  app.post('/xrpc/community.lexicon.book.appointLibrarian', appointLibrarian);
  app.post('/xrpc/community.lexicon.book.revokeLibrarian', revokeLibrarian);
  app.post('/xrpc/community.lexicon.book.createShelf', createShelf);
  app.post('/xrpc/community.lexicon.book.addToShelf', addToShelf);
  app.post('/xrpc/community.lexicon.book.removeFromShelf', removeFromShelf);

  // Provider lookup endpoint
  app.get('/api/lookup/book', async (c) => {
    const { isbn, title, author } = c.req.query();
    const provider = new OpenLibraryProvider();

    try {
      if (isbn) {
        const result = await provider.searchByIsbn(isbn);
        return c.json(result ? { found: true, data: result } : { found: false });
      }

      if (title) {
        const results = await provider.searchByTitle(title, author);
        return c.json({ found: results.length > 0, data: results });
      }

      return c.json({ error: 'Provide isbn or title' }, 400);
    } catch (err) {
      return c.json({ error: 'ProviderError', message: String(err) }, 502);
    }
  });

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

// EXPORT for the indexer to access the Open Library provider instance
export const openLibrary = new OpenLibraryProvider();
