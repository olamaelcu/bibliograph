// The consumer gates on TAP's own backlog, not on a guess: `/channel` carries no
// cursor, so the outbox is where unprocessed events actually wait. These cases
// pin the parsing and the "unknown is not zero" rule that keeps the fallback
// alive when a TAP build does not publish stats.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTapStats, resetTapStatsCache } from './tap-stats';

const BASE = 'http://tap.test:2480';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(handlers: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const handler = handlers[url.pathname];
    if (!handler) return new Response('not found', { status: 404 });
    return handler();
  }) as typeof globalThis.fetch;
  return { impl, calls };
}

test('reads the outbox buffer without a query string on the base url', async () => {
  resetTapStatsCache();
  const { impl, calls } = fakeFetch({
    '/stats/outbox-buffer': () => jsonResponse({ outbox_buffer: 2863 }),
    '/stats/resync-buffer': () => jsonResponse({ resync_buffer: 4 }),
  });

  const stats = await fetchTapStats('http://tap.test:2480?cursor=42', { fetch: impl });

  assert.deepEqual(stats, { outboxBuffer: 2863, resyncBuffer: 4 });
  assert.deepEqual(calls.sort(), ['/stats/outbox-buffer', '/stats/resync-buffer']);
});

test('treats a missing resync reading as zero, not as a failure', async () => {
  resetTapStatsCache();
  const { impl } = fakeFetch({
    '/stats/outbox-buffer': () => jsonResponse({ outbox_buffer: 7 }),
  });

  const stats = await fetchTapStats(BASE, { fetch: impl });
  assert.deepEqual(stats, { outboxBuffer: 7, resyncBuffer: 0 });
});

test('returns null when the outbox reading is unavailable', async () => {
  resetTapStatsCache();
  const { impl } = fakeFetch({
    '/stats/outbox-buffer': () => new Response('nope', { status: 500 }),
    '/stats/resync-buffer': () => jsonResponse({ resync_buffer: 1 }),
  });

  assert.equal(await fetchTapStats(BASE, { fetch: impl }), null);
});

test('returns null when TAP cannot be reached at all', async () => {
  resetTapStatsCache();
  const impl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof globalThis.fetch;

  assert.equal(await fetchTapStats(BASE, { fetch: impl }), null);
});

test('caches a reading for a second so the event loop is not querying per event', async () => {
  resetTapStatsCache();
  const { impl, calls } = fakeFetch({
    '/stats/outbox-buffer': () => jsonResponse({ outbox_buffer: 1 }),
    '/stats/resync-buffer': () => jsonResponse({ resync_buffer: 0 }),
  });

  await fetchTapStats(BASE, { fetch: impl, now: 1_000 });
  await fetchTapStats(BASE, { fetch: impl, now: 1_500 });
  assert.equal(calls.length, 2, 'second read inside the TTL must not hit TAP');

  await fetchTapStats(BASE, { fetch: impl, now: 2_500 });
  assert.equal(calls.length, 4, 'a read past the TTL refetches');
});
