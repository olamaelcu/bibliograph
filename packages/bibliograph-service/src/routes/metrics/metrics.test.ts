import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from './+server';

function fakeEvent() {
  return { request: new Request('http://localhost/metrics'), locals: {}, url: new URL('http://localhost/metrics') } as never;
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