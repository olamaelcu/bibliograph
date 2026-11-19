/**
 * The drain that keeps the external index in step with Postgres.
 *
 * Runs against the suite's throwaway Postgres, so the catalog triggers are the
 * real ones: inserting, updating and deleting a book is what queues the change
 * and this is what applies it. The index service is a stub that records the
 * bodies it receives.
 *
 * Every test creates its own book: the container is shared by the whole suite,
 * so no test may depend on a row another one left behind.
 */

import http from 'node:http';

import { afterAll, beforeAll, expect, test } from 'vitest';
import pg from 'pg';

import { drainSearchIndex } from '../lib/search-index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = `at://did:plc:draintest/${process.pid}-${Date.now()}`;
let sequence = 0;
const uris = [];

let pool;
let server;
let received;

function startStub(status = 200) {
  received = [];
  return new Promise((resolve) => {
    server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        received.push(JSON.parse(body));
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ upserts: 0, deletes: 0, docs: 0 }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const closed = () => new Promise((resolve) => server.close(resolve));

async function dirtyFor(uri) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM search_dirty WHERE uri = $1', [uri]);
  return rows[0].n;
}

async function insertBook(title, language = 'en') {
  sequence += 1;
  const uri = `${PREFIX}/${sequence}`;
  uris.push(uri);
  await pool.query('INSERT INTO books (uri, title, created_at) VALUES ($1, $2, now())', [uri, title]);
  await pool.query(
    `INSERT INTO edition_shape (edition_uri, language, published_date, description)
     VALUES ($1, $2, '1965', 'Queued by a trigger.')`,
    [uri, language]
  );
  return uri;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
});

afterAll(async () => {
  await pool.query('DELETE FROM books WHERE uri = ANY($1::text[])', [uris]);
  await pool.end();
  if (server) await closed();
});

test('a queued insert becomes an upsert with the current document, then is acked', async () => {
  const url = await startStub();
  const uri = await insertBook('Drain Probe');
  expect(await dirtyFor(uri)).toBe(1);

  const result = await drainSearchIndex({
    pool,
    searchUrl: url,
    batchSize: 500,
    maxBatches: 20,
    uris: [uri]
  });

  expect(result.applied).toBeGreaterThanOrEqual(1);
  expect(await dirtyFor(uri)).toBe(0);
  const posted = received.flatMap((body) => body.upsert).find((doc) => doc.uri === uri);
  expect(posted).toMatchObject({
    title: 'Drain Probe',
    language: 'en',
    year: 1965,
    description: 'Queued by a trigger.'
  });
  expect(posted.contributors).toEqual([]);
  await closed();
});

test('an update is rebuilt at drain time, not replayed from the queue', async () => {
  const url = await startStub();
  const uri = await insertBook('Drain Probe Before');
  await pool.query('UPDATE books SET title = $2 WHERE uri = $1', [uri, 'Drain Probe After']);
  expect(await dirtyFor(uri)).toBe(1);

  await drainSearchIndex({ pool, searchUrl: url, batchSize: 500, maxBatches: 20, uris: [uri] });

  const posted = received.flatMap((body) => body.upsert).find((doc) => doc.uri === uri);
  expect(posted.title).toBe('Drain Probe After');
  expect(await dirtyFor(uri)).toBe(0);
  await closed();
});

test('a delete is posted as a delete', async () => {
  const url = await startStub();
  const uri = await insertBook('Gone Probe');
  await pool.query('DELETE FROM books WHERE uri = $1', [uri]);
  expect(await dirtyFor(uri)).toBe(1);

  await drainSearchIndex({ pool, searchUrl: url, batchSize: 500, maxBatches: 20, uris: [uri] });

  const deleted = received.some((body) => body.delete.includes(uri));
  expect(deleted).toBe(true);
  expect(await dirtyFor(uri)).toBe(0);
  await closed();
});

test('a failing post leaves the change queued for the next attempt', async () => {
  const url = await startStub(500);
  const uri = await insertBook('Retry Probe');
  expect(await dirtyFor(uri)).toBe(1);

  await expect(
    drainSearchIndex({ pool, searchUrl: url, batchSize: 500, maxBatches: 20, uris: [uri] })
  ).rejects.toThrow(/HTTP 500/);
  expect(await dirtyFor(uri)).toBe(1);
  await closed();
});
