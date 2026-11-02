import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { sql } from 'drizzle-orm';
import { GB_CACHE_TTL_MS, gbCacheEntry, gbCacheGet, gbCachePut } from './cache';
import { db } from '../db';

const log = pino({ level: 'silent' });

// The cache is durable and shared with every other process, so each run uses its
// own queries: a fixed query would be answered by a row written by the previous
// run, and clearing the table would race the api tests in a parallel process.
const RUN = Math.floor(Math.random() * 1e9).toString(36);
const BASE = 'https://www.googleapis.com/books/v1/volumes';
const WITH_KEY_A = `${BASE}?q=dune-${RUN}&maxResults=10&key=key-a`;
const WITH_KEY_B = `${BASE}?q=dune-${RUN}&maxResults=10&key=key-b`;
const REORDERED = `${BASE}?maxResults=10&key=key-a&q=dune-${RUN}`;
const OTHER_QUERY = `${BASE}?q=emma-${RUN}&maxResults=10&key=key-a`;

test('gbCacheEntry ignores the API key and parameter order', () => {
  const a = gbCacheEntry(WITH_KEY_A);
  assert.equal(gbCacheEntry(WITH_KEY_B).key, a.key, 'key rotation must not drop the entry');
  assert.equal(gbCacheEntry(REORDERED).key, a.key, 'parameter order must not split the entry');
  assert.doesNotMatch(a.url, /key=/, 'the credential must never be persisted');
  assert.equal(a.url, `${BASE}?maxResults=10&q=dune-${RUN}`);
  assert.notEqual(gbCacheEntry(OTHER_QUERY).key, a.key);
});

test('a stored response is served for the same normalized URL', async () => {
  await gbCachePut(gbCacheEntry(WITH_KEY_A), { totalItems: 1, items: [{ id: 'vol1' }] }, log);
  const got = await gbCacheGet<{ totalItems: number; items: Array<{ id: string }> }>(
    gbCacheEntry(WITH_KEY_B).key,
    log,
  );
  assert.equal(got.found, true);
  assert.equal(got.body?.totalItems, 1);
  assert.equal(got.body?.items[0]?.id, 'vol1');
});

test('a negative entry is found with a null body', async () => {
  const entry = gbCacheEntry(WITH_KEY_A);
  await gbCachePut(entry, null, log);
  const got = await gbCacheGet(entry.key, log);
  assert.equal(got.found, true, 'a cached miss must be distinguishable from nothing cached');
  assert.equal(got.body, null);
});

test('an unknown URL is a miss', async () => {
  const got = await gbCacheGet(gbCacheEntry(OTHER_QUERY).key, log);
  assert.equal(got.found, false);
});

test('an expired entry is not served, and re-storing revives it', async () => {
  const entry = gbCacheEntry(WITH_KEY_A);
  await gbCachePut(entry, { totalItems: 7 }, log);
  await db.execute(
    sql`update google_books_cache set expires_at = now() - interval '1 second' where key = ${entry.key}`,
  );
  assert.equal((await gbCacheGet(entry.key, log)).found, false);

  await gbCachePut(entry, { totalItems: 8 }, log);
  const revived = await gbCacheGet<{ totalItems: number }>(entry.key, log);
  assert.equal(revived.found, true);
  assert.equal(revived.body?.totalItems, 8, 're-store must replace the stale body');
});

test('hits and misses both live for one day', async () => {
  const hitEntry = gbCacheEntry(WITH_KEY_A);
  const missEntry = gbCacheEntry(OTHER_QUERY);
  await gbCachePut(hitEntry, { totalItems: 1 }, log);
  await gbCachePut(missEntry, null, log);
  const rows = await db.execute<{ ttl_seconds: string }>(
    sql`select extract(epoch from (expires_at - fetched_at))::bigint as ttl_seconds
        from google_books_cache where key in (${hitEntry.key}, ${missEntry.key})`,
  );
  assert.equal(rows.rows.length, 2);
  for (const row of rows.rows) {
    assert.equal(Number(row.ttl_seconds) * 1000, GB_CACHE_TTL_MS);
  }
});
