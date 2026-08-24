import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { withRetry } from './retry.ts';

const log = pino({ level: 'silent' });

class HttpError extends Error {
  constructor(public status: number, msg?: string) {
    super(msg ?? `HTTP ${status}`);
  }
}

test('withRetry returns on first success without retrying', async () => {
  let calls = 0;
  const result = await withRetry(() => { calls++; return Promise.resolve('ok'); }, log);
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries on 429 and eventually succeeds', async () => {
  let calls = 0;
  const result = await withRetry(() => {
    calls++;
    if (calls < 3) throw new HttpError(429);
    return Promise.resolve('ok');
  }, log, { baseDelayMs: 1, maxDelayMs: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry retries on 500 and eventually succeeds', async () => {
  let calls = 0;
  const result = await withRetry(() => {
    calls++;
    if (calls < 2) throw new HttpError(503);
    return Promise.resolve('ok');
  }, log, { baseDelayMs: 1, maxDelayMs: 5 });
  assert.equal(calls, 2);
});

test('withRetry does NOT retry on 4xx other than 429', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(() => { calls++; throw new HttpError(404); }, log),
    /HTTP 404/,
  );
  assert.equal(calls, 1);
});

test('withRetry gives up after maxAttempts and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(() => { calls++; throw new HttpError(500); }, log, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }),
    /HTTP 500/,
  );
  assert.equal(calls, 3);
});

test('withRetry honors custom retryOn', async () => {
  let calls = 0;
  // retryOn that accepts only 418
  await assert.rejects(
    withRetry(
      () => { calls++; throw new HttpError(418); },
      log,
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, retryOn: (s) => s === 418 },
    ),
  );
  assert.equal(calls, 3);
});