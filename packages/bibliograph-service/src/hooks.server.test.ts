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

test('hooks.server records histogram for /.well-known/atproto-did (well-known branch)', async () => {
  metricsRegistry.resetMetrics();
  const resolve = async () => new Response('did:plc:test', { status: 200 });
  await handle(makeInput('/.well-known/atproto-did', 'GET', resolve));
  const body = await metricsRegistry.metrics();
  assert.match(
    body,
    /http_request_duration_ms_bucket\{[^}]*path="\/\.well-known\/atproto-did"[^}]*\}/,
  );
});

test('hooks.server records histogram for /xrpc/* paths (xrpc branch)', async () => {
  metricsRegistry.resetMetrics();
  // The xrpc branch dispatches to router.fetch (ignoring `resolve`). The
  // router's built-in /xrpc/_health handler is a no-op that returns 200,
  // so we exercise the real router without needing a mock or fixture.
  await handle(makeInput('/xrpc/_health', 'GET', async () => new Response('unused')));
  const body = await metricsRegistry.metrics();
  assert.match(body, /http_request_duration_ms_bucket\{[^}]*path="\/xrpc\/_health"[^}]*\}/);
});