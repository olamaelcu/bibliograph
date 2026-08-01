import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getBook, getBooks, getReviews, getUserStatus, searchBooksHandler, getClaims } from './api/get-book.js';
import { createBook, createReview, createStatus, createClaim } from './api/create-book.js';
import { handleRecordEvent } from './indexer.js';
import { OpenLibraryProvider } from './providers/openlibrary.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', cors());

  // Root route
  app.get('/', (c) => {
    const host = new URL(c.req.url).host;
    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Bibliograph</title>
  <style>
    body { font-family: monospace; background: #0a0a0a; color: #f0e6d3;
           display: flex; justify-content: center; align-items: center;
          flex-direction: column;
           min-height: 100vh; margin: 0; }
    pre { font-size: 14px; line-height: 1.2; text-align: center; display: block; }
    .info { color: #8a7a5a; margin-top: 1rem; font-size: 12px; }
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
  |   |                   |   |
  |   |    ~ book ~       |   |
  |   |    ~ review ~     |   |
  |   |    ~ claim ~      |   |
  |   '-------------------'   |
  |                           |
   \\_________________________/
</pre>
<br />
<div class="info">Bibliograph &mdash; ${host}</div>
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

  // Procedure endpoints (POST /xrpc/...)
  app.post('/xrpc/community.lexicon.book.createBook', createBook);
  app.post('/xrpc/community.lexicon.book.createReview', createReview);
  app.post('/xrpc/community.lexicon.book.createStatus', createStatus);
  app.post('/xrpc/community.lexicon.book.createClaim', createClaim);

  // Tap webhook endpoint (for receiving events)
  app.post('/tap/event', async (c) => {
    const body = await c.req.json<{ record?: { action: string; did: string; rev: string; collection: string; rkey: string; record?: Record<string, unknown>; cid?: string; live: boolean } }>();

    if (body.record) {
      const rec = body.record;
      await handleRecordEvent({
        type: 'record',
        action: rec.action as 'create' | 'update' | 'delete',
        did: rec.did,
        rev: rec.rev,
        collection: rec.collection,
        rkey: rec.rkey,
        record: rec.record,
        cid: rec.cid,
        live: rec.live,
      });
    }

    return c.json({ ok: true });
  });

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
    if (typeof err === 'object' && err !== null && 'status' in err) {
      const e = err as unknown as { status: number; error: string; message: string };
      return c.json({ error: e.error || 'UnexpectedError', message: e.message || 'An error occurred' }, e.status as never);
    }
    console.error('Unhandled error:', err);
    return c.json({ error: 'InternalServerError', message: 'An unexpected error occurred' }, 500);
  });

  return app;
}

// EXPORT for the indexer to access the Open Library provider instance
export const openLibrary = new OpenLibraryProvider();
