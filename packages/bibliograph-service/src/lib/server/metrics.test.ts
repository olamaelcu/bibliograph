import test from 'node:test';
import assert from 'node:assert/strict';
import {
  metricsRegistry,
  httpRequestDurationMs,
  searchRequestsTotal,
  upstreamRequestsTotal,
  searchLatencyMs,
  upstreamLatencyMs,
} from './metrics';

test('metricsRegistry registers default process metrics', async () => {
  const body = await metricsRegistry.metrics();
  assert.match(body, /process_cpu_user_seconds_total/);
});

test('metricsRegistry exposes http_request_duration_ms histogram', async () => {
  const body = await metricsRegistry.metrics();
  assert.match(body, /http_request_duration_ms/);
});

test('httpRequestDurationMs observes a sample with method/status/path labels', () => {
  httpRequestDurationMs.observe({ method: 'GET', status: '200', path: '/x' }, 12);
  assert.ok(httpRequestDurationMs);
});

test('metrics module exports all counter and histogram symbols', () => {
  assert.ok(searchRequestsTotal);
  assert.ok(upstreamRequestsTotal);
  assert.ok(searchLatencyMs);
  assert.ok(upstreamLatencyMs);
});