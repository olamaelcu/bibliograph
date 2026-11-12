import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Registry,
  collectProcessMetrics,
  createWebMetrics,
  feedOutcomeForStatus,
  normalizeFeedKind,
  normalizeHttpMethod,
  normalizeRoute,
  normalizeStatus,
  normalizeXrpcMethod,
  recordCatalogQuery,
  recordFeedRequest,
  recordHappyViewRequest,
  recordHttpRequest,
  recordPdsProxyRequest,
  renderWebMetrics
} from '../src/lib/server/metrics.ts';

/**
 * The registry is the contract infra scrapes: exact family names, label names,
 * escaping and cumulative histogram semantics. These tests pin the text format
 * without a database, an HTTP server, or any external dependency.
 */

test('counters render escaped label values and accumulate one series per tuple', () => {
  const registry = new Registry();
  const counter = registry.counter('test_total', 'multi\nline help');
  counter.inc({ quote: 'a"b', backslash: 'a\\b', newline: 'a\nb' });
  counter.inc({ quote: 'a"b', backslash: 'a\\b', newline: 'a\nb' }, 2);
  counter.inc({ quote: 'plain' });

  const text = registry.render();
  assert.match(text, /^# HELP test_total multi\\nline help$/m);
  assert.match(text, /^# TYPE test_total counter$/m);
  assert.ok(
    text.includes('test_total{quote="a\\"b",backslash="a\\\\b",newline="a\\nb"} 3'),
    text
  );
  assert.match(text, /^test_total\{quote="plain"\} 1$/m);
  assert.equal(text.match(/^test_total\{/gm)?.length, 2, 'the repeated tuple is one series');
});

test('histograms are cumulative across buckets and expose _sum and _count', () => {
  const registry = new Registry();
  const histogram = registry.histogram('test_duration_seconds', 'handler time', [0.1, 1]);
  histogram.observe({ operation: 'x' }, 0.05);
  histogram.observe({ operation: 'x' }, 0.5);
  histogram.observe({ operation: 'x' }, 3);

  const text = registry.render();
  assert.match(text, /^# TYPE test_duration_seconds histogram$/m);
  assert.match(text, /^test_duration_seconds_bucket\{operation="x",le="0.1"\} 1$/m);
  assert.match(text, /^test_duration_seconds_bucket\{operation="x",le="1"\} 2$/m);
  assert.match(text, /^test_duration_seconds_bucket\{operation="x",le="\+Inf"\} 3$/m);
  const sum = /^test_duration_seconds_sum\{operation="x"\} (.+)$/m.exec(text);
  assert.ok(sum, text);
  assert.ok(Math.abs(Number(sum[1]) - 3.55) < 1e-9, `sum was ${sum[1]}`);
  assert.match(text, /^test_duration_seconds_count\{operation="x"\} 3$/m);
});

test('non-finite and negative observations never reach the exposition', () => {
  const registry = new Registry();
  const histogram = registry.histogram('test_seconds', 'h', [1]);
  histogram.observe({}, Number.NaN);
  histogram.observe({}, -1);
  assert.doesNotMatch(registry.render(), /^test_seconds_count/m);
});

test('HTTP requests use route-id, method and status label normalizers', () => {
  const metrics = createWebMetrics();
  recordHttpRequest(metrics, { method: 'get', route: null, status: 200, durationSeconds: 0.2 });
  recordHttpRequest(metrics, {
    method: 'PROPFIND',
    route: '/admin',
    status: 999,
    durationSeconds: 0.1
  });

  const text = renderWebMetrics(metrics);
  assert.match(
    text,
    /^bibliograph_http_requests_total\{method="GET",route="unmatched",status="200"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_http_requests_total\{method="other",route="\/admin",status="unknown"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_http_request_duration_seconds_bucket\{method="GET",route="unmatched",le="0\.25"\} 1$/m
  );

  assert.equal(normalizeHttpMethod('delete'), 'DELETE');
  assert.equal(normalizeHttpMethod('CONNECT'), 'other');
  assert.equal(normalizeRoute(undefined), 'unmatched');
  assert.equal(normalizeRoute('/xrpc/[...method]'), '/xrpc/[...method]');
  assert.equal(normalizeStatus(0), '0');
  assert.equal(normalizeStatus(404), '404');
  assert.equal(normalizeStatus(42), 'unknown');
});

test('proxy counters collapse unknown NSIDs to other and mark thrown calls', () => {
  const metrics = createWebMetrics();
  recordHappyViewRequest(metrics, { method: 'com.atproto.repo.getRecord', status: 200 });
  recordHappyViewRequest(metrics, { method: 'evil.example.unknown', status: 502 });
  recordHappyViewRequest(metrics, {
    method: 'com.atproto.repo.getRecord',
    status: 0,
    outcome: 'exception'
  });
  recordPdsProxyRequest(metrics, { method: 'com.atproto.repo.listRecords', status: 404 });

  const text = renderWebMetrics(metrics);
  assert.match(
    text,
    /^bibliograph_happyview_requests_total\{method="com\.atproto\.repo\.getRecord",outcome="ok",status="200"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_happyview_requests_total\{method="other",outcome="error",status="502"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_happyview_requests_total\{method="com\.atproto\.repo\.getRecord",outcome="exception",status="0"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_pds_proxy_requests_total\{method="com\.atproto\.repo\.listRecords",outcome="error",status="404"\} 1$/m
  );
  assert.equal(
    normalizeXrpcMethod('net.olamaelcu.livtet.biblio.getContributor'),
    'net.olamaelcu.livtet.biblio.getContributor'
  );
  assert.equal(normalizeXrpcMethod('net.olamaelcu.livtet.biblio.getEditions'), 'other');
  assert.equal(normalizeXrpcMethod('com.example.other'), 'other');
});

test('catalog operations and feed kinds are fixed label sets', () => {
  const metrics = createWebMetrics();
  recordCatalogQuery(metrics, 'resolveEditions', 'ok', 0.02);
  recordCatalogQuery(metrics, 'searchEditions', 'unavailable', 0.03);
  recordCatalogQuery(metrics, 'bogus', 'error', 0.01);
  recordFeedRequest(metrics, 'public', 200);
  recordFeedRequest(metrics, 'following', 401);
  recordFeedRequest(metrics, 'invalid', 400);
  recordFeedRequest(metrics, 'weird', 500);

  const text = renderWebMetrics(metrics);
  assert.match(
    text,
    /^bibliograph_catalog_queries_total\{operation="resolveEditions",outcome="ok"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_catalog_queries_total\{operation="searchEditions",outcome="unavailable"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_catalog_queries_total\{operation="other",outcome="error"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_catalog_query_duration_seconds_count\{operation="resolveEditions"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_feed_requests_total\{kind="public",outcome="ok"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_feed_requests_total\{kind="following",outcome="auth_required"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_feed_requests_total\{kind="invalid",outcome="invalid_request"\} 1$/m
  );
  assert.match(
    text,
    /^bibliograph_feed_requests_total\{kind="other",outcome="error"\} 1$/m
  );
  assert.equal(normalizeFeedKind('dynamic'), 'dynamic');
  assert.equal(normalizeFeedKind('private'), 'other');
  assert.equal(feedOutcomeForStatus(503), 'unavailable');
});

test('process gauges are collected from the live process shape', () => {
  const metrics = createWebMetrics();
  collectProcessMetrics(metrics, {
    memoryUsage: () => ({ rss: 1_048_576, heapUsed: 524_288 }),
    cpuUsage: () => ({ user: 1_500_000, system: 500_000 }),
    uptime: () => 12.5
  });

  const text = renderWebMetrics(metrics);
  assert.match(text, /^bibliograph_process_resident_memory_bytes 1048576$/m);
  assert.match(text, /^bibliograph_process_cpu_seconds_total 2$/m);
  assert.match(text, /^bibliograph_process_uptime_seconds 12\.5$/m);
  assert.match(text, /^bibliograph_nodejs_heap_used_bytes 524288$/m);
});

test('an untouched registry still exposes every contracted family header', () => {
  const text = renderWebMetrics(createWebMetrics());
  for (const [name, type] of [
    ['bibliograph_http_requests_total', 'counter'],
    ['bibliograph_http_request_duration_seconds', 'histogram'],
    ['bibliograph_happyview_requests_total', 'counter'],
    ['bibliograph_pds_proxy_requests_total', 'counter'],
    ['bibliograph_catalog_queries_total', 'counter'],
    ['bibliograph_catalog_query_duration_seconds', 'histogram'],
    ['bibliograph_feed_requests_total', 'counter'],
    ['bibliograph_process_resident_memory_bytes', 'gauge'],
    ['bibliograph_process_cpu_seconds_total', 'gauge'],
    ['bibliograph_process_uptime_seconds', 'gauge'],
    ['bibliograph_nodejs_heap_used_bytes', 'gauge']
  ]) {
    assert.match(text, new RegExp(`^# HELP ${name} .+$`, 'm'));
    assert.match(text, new RegExp(`^# TYPE ${name} ${type}$`, 'm'));
  }
  assert.match(text, /^$/m);
});
