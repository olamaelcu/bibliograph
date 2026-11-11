import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from './+server';

function fakeEvent(): Parameters<typeof GET>[0] {
  // The endpoint reads only `request`/`url`; the rest of the RequestEvent
  // surface is irrelevant to the handler under test.
  const event = { request: new Request('http://localhost/metrics'), url: new URL('http://localhost/metrics') };
  return event as unknown as Parameters<typeof GET>[0];
}

test('GET /metrics returns 200 with Prometheus text content-type', async () => {
  const res = await GET(fakeEvent());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
});

test('GET /metrics exposes prom-client default process metrics', async () => {
  const res = await GET(fakeEvent());
  const body = await res.text();
  assert.match(body, /process_cpu_user_seconds_total/);
  assert.match(body, /nodejs_eventloop_lag_seconds/);
});