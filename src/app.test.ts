import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './test-utils/db.js';
import type { Hono } from 'hono';

const dbHolder = vi.hoisted(() => ({
	db: undefined as
		| Awaited<ReturnType<typeof createTestDb>>['db']
		| undefined,
}));
vi.mock('./db/connection.js', () => ({
	get db() {
		return dbHolder.db;
	},
}));

let app: Hono;

beforeAll(async () => {
	const { db } = await createTestDb();
	dbHolder.db = db;
	app = (await import('./app.js')).createApp();
});

const LEXICON_NSIDS = [
  'book',
  'bookShelving',
  'bookContributor',
  'contributor',
  'contributorRole',
  'defs',
  'format',
  'genre',
  'review',
  'shelf',
];

describe('pages', () => {
  it('serves the home page at /', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('net.olamaelcu.livtet.biblio');
    expect(body).toContain('did-ssr');
  });

  it('serves the queries page with no procedures', async () => {
    const res = await app.request('/queries');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('net.olamaelcu.livtet.biblio.searchBooks');
    expect(body).toContain('did-ssr');
  });

  it('serves the procedures page with no procedures (writes go browser → user PDS directly)', async () => {
    const res = await app.request('/procedures');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('did-ssr');
    expect(body).not.toContain('net.olamaelcu.livtet.biblio.searchBooks');
  });

  it('serves the search page', async () => {
    const res = await app.request('/search');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('did-ssr');
    expect(body).toContain('id="search-form"');
    expect(body).toContain('net.olamaelcu.livtet.biblio.searchBooks');
  });

  it('serves the live stats page', async () => {
    const res = await app.request('/stats');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('did-ssr');
    expect(body).toContain('books');
    expect(body).toContain('contributors');
  });

  it('serves live stats as JSON with short-TTL browser cache', async () => {
    const res = await app.request('/stats.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    // 60s browser cache; the server caches in-process for 60s too, so
    // the polling client sees a fast response on the second tick and
    // the DB sees one full count query per minute per process.
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
    const body = await res.json();
    expect(Array.isArray(body.catalog)).toBe(true);
    expect(typeof body.openIssues).toBe('number');
  });

  it('serves webawesome theme assets', async () => {
    const res = await app.request('/webawesome/dist-cdn/styles/webawesome.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('serves the ssr loader script', async () => {
    const res = await app.request('/webawesome/dist-cdn/webawesome.ssr-loader.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });
});

describe('health', () => {
  it('returns ok with version', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '0.0.1' });
  });
});

describe('static lexicon serving', () => {
  for (const nsid of LEXICON_NSIDS) {
    it(`serves ${nsid}.json`, async () => {
      const res = await app.request(`/lexicons/net/olamaelcu/livtet/biblio/${nsid}.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(body.id).toBe(`net.olamaelcu.livtet.biblio.${nsid}`);
    });
  }

  it('returns 404 for an unknown lexicon', async () => {
    const res = await app.request('/lexicons/net/olamaelcu/livtet/biblio/nope.json');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a path traversal attempt', async () => {
    const res = await app.request('/lexicons/../../package.json');
    expect(res.status).toBe(404);
  });
});

describe('cors', () => {
  it('adds access-control-allow-origin', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('.well-known/atproto-did', () => {
  it('serves the service did as text', async () => {
    const res = await app.request('/.well-known/atproto-did');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toMatch(/^did:web:/);
  });
});
