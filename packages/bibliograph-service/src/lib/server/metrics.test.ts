import test from 'node:test';
import assert from 'node:assert/strict';
import {
  metricsRegistry,
  httpRequestDurationMs,
  searchRequestsTotal,
  upstreamRequestsTotal,
  searchLatencyMs,
  upstreamLatencyMs,
  normalizePath,
} from './metrics';

test('metricsRegistry registers default process metrics', async () => {
  const body = await metricsRegistry.metrics();
  assert.match(body, /process_cpu_user_seconds_total/);
});

test('metricsRegistry exposes http_request_duration_ms histogram', async () => {
  const body = await metricsRegistry.metrics();
  assert.match(body, /http_request_duration_ms/);
});

test('httpRequestDurationMs observes a sample with method/status/path labels', async () => {
  const labels = { method: 'GET', status: '200', path: '/x' };
  const countFor = (data: { values: Array<{ value: number; labels: Record<string, string | number>; metricName?: string }> }) =>
    data.values.find(
      (v) =>
        v.metricName === 'http_request_duration_ms_count' &&
        v.labels.path === labels.path &&
        v.labels.method === labels.method &&
        v.labels.status === labels.status,
    )?.value ?? 0;

  const before = countFor(await httpRequestDurationMs.get());
  httpRequestDurationMs.observe(labels, 12);
  const after = countFor(await httpRequestDurationMs.get());

  assert.ok(
    after > before,
    `expected http_request_duration_ms_count for ${JSON.stringify(labels)} to increase (before=${before}, after=${after})`,
  );
});

test('metrics module exports all counter and histogram symbols', () => {
  assert.ok(searchRequestsTotal);
  assert.ok(upstreamRequestsTotal);
  assert.ok(searchLatencyMs);
  assert.ok(upstreamLatencyMs);
  assert.ok(httpRequestDurationMs);
});

test('normalizePath keeps /xrpc/{nsid} verbatim', () => {
  assert.equal(normalizePath('/xrpc/community.lexicon.book.searchEditions'), '/xrpc/community.lexicon.book.searchEditions');
});
test('normalizePath keeps /.well-known/* verbatim', () => {
  assert.equal(normalizePath('/.well-known/atproto-did'), '/.well-known/atproto-did');
});
test('normalizePath collapses DIDs', () => {
  assert.equal(normalizePath('/repo/did:plc:abc123/records'), '/repo/{did}/records');
});
test('normalizePath collapses opaque IDs and numeric segments', () => {
  assert.equal(normalizePath('/api/records/12345'), '/api/records/{id}');
});
test('normalizePath collapses long opaque IDs', () => {
  assert.equal(normalizePath('/api/objects/abcdef1234567890xyz'), '/api/objects/{id}');
});
test('normalizePath collapses did:web DIDs (with dots)', () => {
  assert.equal(normalizePath('/repo/did:web:example.com/records'), '/repo/{did}/records');
});