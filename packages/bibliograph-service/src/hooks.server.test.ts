import test from 'node:test';
import assert from 'node:assert/strict';
import type { RequestEvent } from '@sveltejs/kit';
import { handle } from './hooks.server.js';
import { metricsRegistry } from '$lib/server/metrics.js';

type HandleInput = Parameters<typeof handle>[0];

function makeEvent(pathname: string, method = 'GET'): RequestEvent {
  const url = new URL(`http://localhost${pathname}`);
  const request = new Request(url, { method });
  return {
    url,
    request,
    params: {},
    route: { id: null },
    locals: {},
    cookies: {} as RequestEvent['cookies'],
    fetch: fetch.bind(globalThis),
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
    setHeaders: () => {},
  } as unknown as RequestEvent;
}

function makeInput(pathname: string, method = 'GET', resolve: HandleInput['resolve']): HandleInput {
  return { event: makeEvent(pathname, method), resolve } as unknown as HandleInput;
}

test('hooks.server records http_request_duration_ms for every request', async () => {
  metricsRegistry.resetMetrics();
  const resolve = async () => new Response('ok');
  await handle(makeInput('/health', 'GET', resolve));
  const body = await metricsRegistry.metrics();
  assert.match(body, /http_request_duration_ms_bucket\{[^}]*path="\/health"[^}]*\}/);
});

test('hooks.server records the actual status code in the status label', async () => {
  metricsRegistry.resetMetrics();
  const resolve = async () => new Response('no', { status: 404 });
  await handle(makeInput('/missing', 'GET', resolve));
  const body = await metricsRegistry.metrics();
  assert.match(body, /http_request_duration_ms_bucket\{[^}]*status="404"[^}]*\}/);
});