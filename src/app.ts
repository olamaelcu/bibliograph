import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requestTracing } from './middleware.js';
import { getBook, getBooks, getReviews, getUserStatus, searchBooksHandler, getClaims, getLabelerLabels } from './api/get-book.js';
import { createBook, createReview, createStatus, createClaim, verifyClaim, appointLibrarian, revokeLibrarian } from './api/create-book.js';
import { handleRecordEvent } from './indexer.js'; // kept for potential reuse
import { OpenLibraryProvider } from './providers/openlibrary.js';
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
      'getUserStatus',
      'searchBooks',
      'getClaims',
      'getLabelerLabels',
    ];
    const procedures = [
      'createBook',
      'createReview',
      'createStatus',
      'createClaim',
      'verifyClaim',
      'appointLibrarian',
      'revokeLibrarian',
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
    .other { color: #8a7a5a; margin-top: 1.5rem; font-size: 11px; }
    .other td { padding: 2px 8px; font-size: 11px; }
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

<h2>Queries</h2>
<table>${queryRows}</table>

<h2>Procedures</h2>
<table>${procRows}</table>

<p class="divider">──────────────────────</p>
<table class="other">
<tr><td class="post">POST</td><td>/tap/event</td></tr>
<tr><td class="get">GET</td><td>/api/lookup/book</td></tr>
<tr><td class="get">GET</td><td>/health</td></tr>
</table>

<div class="info">Bibliograph &mdash; ${host}</div>
<div class="info"><a href="https://github.com/olamaelcu/bibliograph">github.com/olamaelcu/bibliograph</a></div>
</body>
</html>`);
  });

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', version: '0.0.1' }));

  // Query endpoints (GET /xrpc/...)
  app.get('/xrpc/community.lexicon.book.getBook', getBook);
  app.get('/xrpc/community.lexicon.book.getBooks', getBooks);
  app.get('/xrpc/community.lexicon.book.getReviews', getReviews);
  app.get('/xrpc/community.lexicon.book.getUserStatus', getUserStatus);
  app.get('/xrpc/community.lexicon.book.searchBooks', searchBooksHandler);
  app.get('/xrpc/community.lexicon.book.getClaims', getClaims);
  app.get('/xrpc/community.lexicon.book.getLabelerLabels', getLabelerLabels);

  // Procedure endpoints (POST /xrpc/...)
  app.post('/xrpc/community.lexicon.book.createBook', createBook);
  app.post('/xrpc/community.lexicon.book.createReview', createReview);
  app.post('/xrpc/community.lexicon.book.createStatus', createStatus);
  app.post('/xrpc/community.lexicon.book.createClaim', createClaim);
  app.post('/xrpc/community.lexicon.book.verifyClaim', verifyClaim);
  app.post('/xrpc/community.lexicon.book.appointLibrarian', appointLibrarian);
  app.post('/xrpc/community.lexicon.book.revokeLibrarian', revokeLibrarian);

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
