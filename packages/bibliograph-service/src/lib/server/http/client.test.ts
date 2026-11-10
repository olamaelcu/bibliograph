import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_HTTP_TIMEOUT_MS, HttpError, parseRetryAfter, requestJson } from './client';

/** A local server whose every response is chosen by the test. */
async function withServer(
  handler: Parameters<typeof createServer>[1],
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
}

test('the transport budget is the 3s the request path is sized for', () => {
  assert.equal(DEFAULT_HTTP_TIMEOUT_MS, 3_000);
});

test('requestJson aborts a call that outlives its timeout', async () => {
  await withServer(
    () => {
      // Never answer: the only way out is the timeout.
    },
    async (base) => {
      const started = Date.now();
      await assert.rejects(
        requestJson(`${base}/slow`, { timeoutMs: 150 }),
        (err: unknown) => err instanceof Error && err.name === 'TimeoutError',
      );
      assert.ok(Date.now() - started < 2_000, 'the call must fail at its own budget, not the default');
    },
  );
});

test('a non-2xx answer becomes an HttpError carrying the status and the provider hint', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(429, { 'retry-after': '2' });
      res.end('slow down');
    },
    async (base) => {
      await assert.rejects(
        requestJson(`${base}/limited`),
        (err: unknown) => err instanceof HttpError && err.status === 429 && err.retryAfterMs === 2_000,
      );
    },
  );
});

test('parseRetryAfter reads both the ISBNdb and the standard header', () => {
  assert.equal(parseRetryAfter(new Headers({ ratelimit: '"rate"; r=4; t=30' })), 30_000);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '5' })), 5_000);
  assert.equal(parseRetryAfter(new Headers()), undefined);
});
